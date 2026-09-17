-- Task 307: append-only technician timer transition ledger.
-- Additive only. Existing job_cards.timer_seconds/timer_started_at values are
-- deliberately not copied into this table: the ledger starts at deployment.

BEGIN;

CREATE TABLE IF NOT EXISTS aura_schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS technician_work_segment_ledger (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  -- No FKs here by design. Historical work evidence must outlive a later
  -- job-card/user deletion and has its own immutable identity snapshots.
  job_card_id integer NOT NULL,
  technician_user_id integer,
  technician_name_snapshot text,
  previous_technician_user_id integer,
  previous_technician_name_snapshot text,
  next_technician_user_id integer,
  next_technician_name_snapshot text,
  dealer_timezone_snapshot text NOT NULL,
  event_type text NOT NULL,
  from_status text,
  to_status text,
  segment_started_at timestamptz,
  segment_ended_at timestamptz,
  duration_seconds integer,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'job_cards_trigger',
  CONSTRAINT technician_work_segment_ledger_event_type_check CHECK (
    event_type IN ('start', 'pause', 'resume', 'status_stopped', 'completed', 'reassigned', 'legacy_timer_stopped')
  )
);

CREATE INDEX IF NOT EXISTS technician_work_segment_ledger_job_occurred_idx
  ON technician_work_segment_ledger (dealer_id, job_card_id, occurred_at);
CREATE INDEX IF NOT EXISTS technician_work_segment_ledger_technician_occurred_idx
  ON technician_work_segment_ledger (dealer_id, technician_user_id, occurred_at);

-- Serializes all timer/identity transitions for a technician. This is needed
-- in addition to job-card row locks because two different cards can otherwise
-- both observe an idle technician. It also makes a reassignment stop the
-- outgoing technician's timer atomically; the incoming technician must resume
-- in a separate transition.
CREATE OR REPLACE FUNCTION technician_work_segment_lock_and_stop()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  first_technician_id integer;
  second_technician_id integer;
BEGIN
  IF TG_OP = 'UPDATE'
    AND (
      OLD.timer_started_at IS DISTINCT FROM NEW.timer_started_at
      OR OLD.technician_user_id IS DISTINCT FROM NEW.technician_user_id
    )
  THEN
    first_technician_id := LEAST(
      COALESCE(OLD.technician_user_id, NEW.technician_user_id),
      COALESCE(NEW.technician_user_id, OLD.technician_user_id)
    );
    second_technician_id := GREATEST(
      COALESCE(OLD.technician_user_id, NEW.technician_user_id),
      COALESCE(NEW.technician_user_id, OLD.technician_user_id)
    );
    IF first_technician_id IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(first_technician_id::bigint);
    END IF;
    IF second_technician_id IS NOT NULL AND second_technician_id <> first_technician_id THEN
      PERFORM pg_advisory_xact_lock(second_technician_id::bigint);
    END IF;

    -- Work never silently transfers between technicians. Fold the outgoing
    -- timer at this transaction's timestamp and require an explicit resume.
    IF OLD.technician_user_id IS DISTINCT FROM NEW.technician_user_id
      AND OLD.timer_started_at IS NOT NULL
    THEN
      NEW.timer_seconds := OLD.timer_seconds
        + GREATEST(0, EXTRACT(EPOCH FROM (now() - OLD.timer_started_at))::integer);
      NEW.timer_started_at := NULL;
    END IF;
  ELSIF TG_OP = 'INSERT' AND NEW.timer_started_at IS NOT NULL AND NEW.technician_user_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(NEW.technician_user_id::bigint);
  END IF;

  -- A second resume may arrive after the first request has already made this
  -- timer active. Do not silently reset its start boundary (which would lose
  -- time and make an unpaired ledger event). Route CAS guards should normally
  -- make this unreachable; this is the database backstop for direct writers.
  IF TG_OP = 'UPDATE'
    AND OLD.technician_user_id IS NOT DISTINCT FROM NEW.technician_user_id
    AND OLD.timer_started_at IS NOT NULL
    AND NEW.timer_started_at IS NOT NULL
    AND OLD.timer_started_at IS DISTINCT FROM NEW.timer_started_at
  THEN
    RAISE EXCEPTION 'Job-card timer is already running'
      USING ERRCODE = '23505',
            CONSTRAINT = 'job_cards_one_running_timer_per_technician';
  END IF;

  IF NEW.timer_started_at IS NOT NULL THEN
    IF NEW.technician_user_id IS NULL THEN
      RAISE EXCEPTION 'A running job-card timer requires an assigned technician'
        USING ERRCODE = '23514',
              CONSTRAINT = 'job_cards_running_timer_technician_required';
    END IF;

    -- The advisory lock above makes this predicate safe across concurrent
    -- cards. Do not index/backfill legacy rows: old timer state remains
    -- untouched while all new transitions are protected.
    PERFORM 1
      FROM job_cards
     WHERE dealer_id = NEW.dealer_id
       AND technician_user_id = NEW.technician_user_id
       AND timer_started_at IS NOT NULL
       AND id IS DISTINCT FROM NEW.id
     FOR UPDATE;
    IF FOUND THEN
      RAISE EXCEPTION 'Technician % already has a running job-card timer', NEW.technician_user_id
        USING ERRCODE = '23505',
              CONSTRAINT = 'job_cards_one_running_timer_per_technician';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION technician_work_segment_capture()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  dealer_tz text;
  old_name text;
  new_name text;
  transition_type text;
  event_technician_id integer;
  event_technician_name text;
  segment_timezone text;
  segment_technician_name text;
  ended_at timestamptz := now();
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.timer_started_at IS NULL THEN
      RETURN NULL;
    END IF;
    SELECT COALESCE(timezone, 'America/Guyana')
      INTO dealer_tz
      FROM dealers
     WHERE id = OLD.dealer_id;
    dealer_tz := COALESCE(dealer_tz, 'America/Guyana');
    old_name := COALESCE(OLD.technician_name,
      (SELECT name FROM users WHERE id = OLD.technician_user_id));
    IF NOT EXISTS (
      SELECT 1
        FROM technician_work_segment_ledger
       WHERE dealer_id = OLD.dealer_id
         AND job_card_id = OLD.id
         AND technician_user_id IS NOT DISTINCT FROM OLD.technician_user_id
         AND event_type IN ('start', 'resume')
    ) THEN
      INSERT INTO technician_work_segment_ledger (
        dealer_id, job_card_id, technician_user_id, technician_name_snapshot,
        previous_technician_user_id, previous_technician_name_snapshot,
        dealer_timezone_snapshot, event_type, from_status, to_status,
        segment_ended_at, occurred_at
      ) VALUES (
        OLD.dealer_id, OLD.id, OLD.technician_user_id, old_name,
        OLD.technician_user_id, old_name,
        dealer_tz, 'legacy_timer_stopped', OLD.status, 'deleted',
        ended_at, ended_at
      );
    ELSE
      SELECT dealer_timezone_snapshot, technician_name_snapshot
        INTO segment_timezone, segment_technician_name
        FROM technician_work_segment_ledger
       WHERE dealer_id = OLD.dealer_id
         AND job_card_id = OLD.id
         AND technician_user_id IS NOT DISTINCT FROM OLD.technician_user_id
         AND event_type IN ('start', 'resume')
       ORDER BY id DESC
       LIMIT 1;
      INSERT INTO technician_work_segment_ledger (
        dealer_id, job_card_id, technician_user_id, technician_name_snapshot,
        previous_technician_user_id, previous_technician_name_snapshot,
        dealer_timezone_snapshot, event_type, from_status, to_status,
        segment_started_at, segment_ended_at, duration_seconds, occurred_at
      ) VALUES (
        OLD.dealer_id, OLD.id, OLD.technician_user_id, segment_technician_name,
        OLD.technician_user_id, segment_technician_name,
        segment_timezone, 'status_stopped', OLD.status, 'deleted',
        OLD.timer_started_at, ended_at,
        GREATEST(0, EXTRACT(EPOCH FROM (ended_at - OLD.timer_started_at))::integer),
        ended_at
      );
    END IF;
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.timer_started_at IS NULL THEN
      RETURN NULL;
    END IF;
    SELECT COALESCE(timezone, 'America/Guyana')
      INTO dealer_tz
      FROM dealers
     WHERE id = NEW.dealer_id;
    dealer_tz := COALESCE(dealer_tz, 'America/Guyana');
    new_name := COALESCE(NEW.technician_name,
      (SELECT name FROM users WHERE id = NEW.technician_user_id));
    INSERT INTO technician_work_segment_ledger (
      dealer_id, job_card_id, technician_user_id, technician_name_snapshot,
      next_technician_user_id, next_technician_name_snapshot,
      dealer_timezone_snapshot, event_type, to_status, segment_started_at, occurred_at
    ) VALUES (
      NEW.dealer_id, NEW.id, NEW.technician_user_id, new_name,
      NEW.technician_user_id, new_name,
      dealer_tz, 'start', NEW.status, NEW.timer_started_at, ended_at
    );
    RETURN NULL;
  END IF;

  SELECT COALESCE(timezone, 'America/Guyana')
    INTO dealer_tz
    FROM dealers
   WHERE id = NEW.dealer_id;
  dealer_tz := COALESCE(dealer_tz, 'America/Guyana');
  old_name := COALESCE(OLD.technician_name,
    (SELECT name FROM users WHERE id = OLD.technician_user_id));
  new_name := COALESCE(NEW.technician_name,
    (SELECT name FROM users WHERE id = NEW.technician_user_id));

  IF OLD.timer_started_at IS NULL AND NEW.timer_started_at IS NOT NULL THEN
    transition_type := CASE WHEN EXISTS (
      SELECT 1
        FROM technician_work_segment_ledger
       WHERE dealer_id = NEW.dealer_id
         AND job_card_id = NEW.id
         AND event_type IN ('start', 'resume')
    ) THEN 'resume' ELSE 'start' END;
    INSERT INTO technician_work_segment_ledger (
      dealer_id, job_card_id, technician_user_id, technician_name_snapshot,
      previous_technician_user_id, previous_technician_name_snapshot,
      next_technician_user_id, next_technician_name_snapshot,
      dealer_timezone_snapshot, event_type, from_status, to_status,
      segment_started_at, occurred_at
    ) VALUES (
      NEW.dealer_id, NEW.id, NEW.technician_user_id, new_name,
      OLD.technician_user_id, old_name, NEW.technician_user_id, new_name,
      dealer_tz, transition_type, OLD.status, NEW.status,
      NEW.timer_started_at, ended_at
    );
  ELSIF OLD.timer_started_at IS NOT NULL AND NEW.timer_started_at IS NULL THEN
    event_technician_id := OLD.technician_user_id;
    event_technician_name := old_name;
    -- A running timer that predates this migration has no ledger start
    -- boundary. Record its stop for auditability, but never manufacture a
    -- segment or allocate its accumulated/pre-deployment time.
    IF NOT EXISTS (
      SELECT 1
        FROM technician_work_segment_ledger
       WHERE dealer_id = OLD.dealer_id
         AND job_card_id = OLD.id
         AND technician_user_id IS NOT DISTINCT FROM OLD.technician_user_id
         AND event_type IN ('start', 'resume')
    ) THEN
      INSERT INTO technician_work_segment_ledger (
        dealer_id, job_card_id, technician_user_id, technician_name_snapshot,
        previous_technician_user_id, previous_technician_name_snapshot,
        next_technician_user_id, next_technician_name_snapshot,
        dealer_timezone_snapshot, event_type, from_status, to_status,
        segment_ended_at, occurred_at
      ) VALUES (
        NEW.dealer_id, NEW.id, event_technician_id, event_technician_name,
        OLD.technician_user_id, old_name, NEW.technician_user_id, new_name,
        dealer_tz, 'legacy_timer_stopped', OLD.status, NEW.status,
        ended_at, ended_at
      );
    ELSE
      SELECT dealer_timezone_snapshot, technician_name_snapshot
        INTO segment_timezone, segment_technician_name
        FROM technician_work_segment_ledger
       WHERE dealer_id = OLD.dealer_id
         AND job_card_id = OLD.id
         AND technician_user_id IS NOT DISTINCT FROM OLD.technician_user_id
         AND event_type IN ('start', 'resume')
       ORDER BY id DESC
       LIMIT 1;
      event_technician_name := segment_technician_name;
      transition_type := CASE
        WHEN OLD.technician_user_id IS DISTINCT FROM NEW.technician_user_id THEN 'reassigned'
        WHEN NEW.status = 'completed' AND OLD.status IS DISTINCT FROM NEW.status THEN 'completed'
        WHEN OLD.status IS DISTINCT FROM NEW.status THEN 'status_stopped'
        ELSE 'pause'
      END;
    INSERT INTO technician_work_segment_ledger (
      dealer_id, job_card_id, technician_user_id, technician_name_snapshot,
      previous_technician_user_id, previous_technician_name_snapshot,
      next_technician_user_id, next_technician_name_snapshot,
      dealer_timezone_snapshot, event_type, from_status, to_status,
      segment_started_at, segment_ended_at, duration_seconds, occurred_at
    ) VALUES (
      NEW.dealer_id, NEW.id, event_technician_id, event_technician_name,
        OLD.technician_user_id, segment_technician_name,
        NEW.technician_user_id, new_name,
        segment_timezone, transition_type, OLD.status, NEW.status,
      OLD.timer_started_at, ended_at,
      GREATEST(0, EXTRACT(EPOCH FROM (ended_at - OLD.timer_started_at))::integer),
      ended_at
    );
    END IF;
  END IF;

  -- Completion remains auditable even when its timer was already paused.
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM NEW.status
    AND NOT (OLD.timer_started_at IS NOT NULL AND NEW.timer_started_at IS NULL)
  THEN
    INSERT INTO technician_work_segment_ledger (
      dealer_id, job_card_id, technician_user_id, technician_name_snapshot,
      previous_technician_user_id, previous_technician_name_snapshot,
      next_technician_user_id, next_technician_name_snapshot,
      dealer_timezone_snapshot, event_type, from_status, to_status, occurred_at
    ) VALUES (
      NEW.dealer_id, NEW.id, NEW.technician_user_id, new_name,
      OLD.technician_user_id, old_name, NEW.technician_user_id, new_name,
      dealer_tz, 'completed', OLD.status, NEW.status, ended_at
    );
  END IF;

  -- Assignment/reassignment is retained even when no timer was running.
  IF OLD.technician_user_id IS DISTINCT FROM NEW.technician_user_id
    AND NOT (OLD.timer_started_at IS NOT NULL AND NEW.timer_started_at IS NULL)
  THEN
    event_technician_id := COALESCE(OLD.technician_user_id, NEW.technician_user_id);
    event_technician_name := COALESCE(old_name, new_name);
    INSERT INTO technician_work_segment_ledger (
      dealer_id, job_card_id, technician_user_id, technician_name_snapshot,
      previous_technician_user_id, previous_technician_name_snapshot,
      next_technician_user_id, next_technician_name_snapshot,
      dealer_timezone_snapshot, event_type, from_status, to_status, occurred_at
    ) VALUES (
      NEW.dealer_id, NEW.id, event_technician_id, event_technician_name,
      OLD.technician_user_id, old_name, NEW.technician_user_id, new_name,
      dealer_tz, 'reassigned', OLD.status, NEW.status, ended_at
    );
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION technician_work_segment_ledger_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Reserved for migration/test cleanup only. Runtime code never sets this
  -- transaction-local setting, so normal application writes are append-only.
  IF current_setting('app.technician_work_segment_ledger_maintenance', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'technician_work_segment_ledger is append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS job_cards_technician_work_segment_lock ON job_cards;
CREATE TRIGGER job_cards_technician_work_segment_lock
  BEFORE INSERT OR UPDATE OF timer_started_at, timer_seconds, technician_user_id ON job_cards
  FOR EACH ROW EXECUTE FUNCTION technician_work_segment_lock_and_stop();

DROP TRIGGER IF EXISTS job_cards_technician_work_segment_capture ON job_cards;
CREATE TRIGGER job_cards_technician_work_segment_capture
  AFTER INSERT OR UPDATE OF timer_started_at, technician_user_id, status ON job_cards
  FOR EACH ROW EXECUTE FUNCTION technician_work_segment_capture();

DROP TRIGGER IF EXISTS job_cards_technician_work_segment_delete_capture ON job_cards;
CREATE TRIGGER job_cards_technician_work_segment_delete_capture
  AFTER DELETE ON job_cards
  FOR EACH ROW EXECUTE FUNCTION technician_work_segment_capture();

DROP TRIGGER IF EXISTS technician_work_segment_ledger_immutable_trigger
  ON technician_work_segment_ledger;
CREATE TRIGGER technician_work_segment_ledger_immutable_trigger
  BEFORE UPDATE OR DELETE ON technician_work_segment_ledger
  FOR EACH ROW EXECUTE FUNCTION technician_work_segment_ledger_immutable();

INSERT INTO aura_schema_migrations(name)
VALUES ('2026-09-30-technician-work-segment-ledger')
ON CONFLICT (name) DO NOTHING;

COMMIT;
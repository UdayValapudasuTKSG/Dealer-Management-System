-- Nullable by design: old account-wide suspensions remain effective until
-- a manager explicitly changes that dealership's membership.
ALTER TABLE dealer_users ADD COLUMN IF NOT EXISTS status text;

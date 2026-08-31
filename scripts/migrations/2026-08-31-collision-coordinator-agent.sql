-- Add the governed collision handoff agent to every existing dealership.
-- New dealerships receive it from DEFAULT_AGENTS in provisioning.ts.
INSERT INTO agents (dealer_id, key, name, domain, description, status)
SELECT d.id,
       'collision_coordinator',
       'Collision Coordinator',
       'Service & Repair',
       'Routes collision claim handoffs, approval reminders and finance actions while leaving protected decisions to staff.',
       'active'
FROM dealers d
WHERE NOT EXISTS (
  SELECT 1
  FROM agents a
  WHERE a.dealer_id = d.id
    AND a.key = 'collision_coordinator'
);
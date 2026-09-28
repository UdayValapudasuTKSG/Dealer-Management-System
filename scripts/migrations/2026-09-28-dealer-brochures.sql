-- Additive, repeatable migration; run against development only.
CREATE TABLE IF NOT EXISTS dealer_brochures (
  id text PRIMARY KEY,
  dealer_id integer NOT NULL REFERENCES dealers(id),
  title text NOT NULL,
  file_name text NOT NULL,
  object_path text NOT NULL UNIQUE,
  sha text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 20971520),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS dealer_brochures_object_path_idx ON dealer_brochures(object_path);
CREATE INDEX IF NOT EXISTS dealer_brochures_dealer_idx ON dealer_brochures(dealer_id, active);
-- Original GT catalog becomes manageable, while existing outbox jobs still
-- reference their immutable original PDF keys independently of these rows.
INSERT INTO dealer_brochures (id, dealer_id, title, file_name, object_path, sha, size_bytes)
SELECT entry.id, d.id, entry.title, entry.file_name,
  '/objects/brochures/dealer-1/' || entry.sha || '.pdf', entry.sha, entry.size_bytes
FROM dealers d
CROSS JOIN (VALUES
  ('sealion-7', 'BYD Sealion 7 EV flyer (email-optimized copy)', 'BYD-Sealion-7-Email-Optimized.pdf', '7ed69e38a3a2d69f4b4e7a3006cba46d81dfba6667b7e26b025c6d572dec21e6', 1500239),
  ('dolphin-mini', 'BYD Dolphin Mini brochure', 'BYD-Dolphin-Mini-Brochure.pdf', '26e21a35c479d2023309e6809d52b6c276b39ac224c4401889b72ea3778e97b3', 5043698),
  ('atto-8', 'BYD Atto 8 brochure', 'BYD-Atto-8-Brochure.pdf', '862ba9fc6b2908ceb85213c5bcc8dcf455ed7b128cd9a220130dcac2b886d3cd', 2547726),
  ('shark', 'BYD Shark brochure', 'BYD-Shark-Brochure.pdf', 'bd58361d6d4f5fa935a8f9c59a35681c8057a08b993d9cfbef1c6e44fe3ce3a6', 1646884),
  ('song-plus-dmi', 'BYD Song Plus DM-i brochure', 'BYD-Song-Plus-DM-i-Brochure.pdf', 'c2ca09a9f609d45e1616fcbf1ef7885318c646208b4944f4375c2dd2e6df8098', 959502),
  ('song-pro', 'BYD Song Pro brochure', 'BYD-Song-Pro-Brochure.pdf', 'a8dafabff723049e98c6f36b4454c5716e39e64157f1c89dc498d9bf9e4a311e', 3614283),
  ('yuan-plus', 'BYD Yuan Plus brochure', 'BYD-Yuan-Plus-Brochure.pdf', 'b0fe02279391ff916fafb380c4025a8ab5bf76f01ff8d0ff61a6c83c24d060ed', 2626951)
) AS entry(id, title, file_name, sha, size_bytes)
WHERE d.id = 1 AND d.name = 'GT Automotive'
ON CONFLICT (id) DO NOTHING;
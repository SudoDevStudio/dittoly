-- Code sandboxes (src/engine/sandbox-housekeeping.ts): which server processes are alive (their containers,
-- networks and folders carry the owner id; a dead owner's are removed), the slots that cap how many app and
-- fix steps build and test at once, and the step images Dittoly pulled (removed when unused for a while).
CREATE TABLE sandbox_owners (
  id text PRIMARY KEY,
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sandbox_slots (
  slot integer PRIMARY KEY,
  owner text,
  run_id uuid,
  step_id text,
  until timestamptz
);

CREATE TABLE sandbox_images (
  image text PRIMARY KEY,
  pulled boolean NOT NULL,
  last_used_at timestamptz NOT NULL DEFAULT now()
);

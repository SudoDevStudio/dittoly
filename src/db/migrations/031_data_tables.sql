-- Data tables: a team's own small tables that its Flows read and write, and people edit in the portal.
CREATE TABLE data_tables (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id      uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name         text NOT NULL,
  description  text,
  -- the column that tells rows apart (its values are the row keys)
  key_column   text NOT NULL,
  -- [{ "name": "status", "type": "text" | "number" | "boolean" | "date" }]
  columns      jsonb NOT NULL,
  created_by   uuid NOT NULL REFERENCES members(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, name)
);

-- Rows are encrypted like run outputs. The key is found by a keyed hash, so keys such as
-- email addresses are not stored readable either.
CREATE TABLE data_rows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id    uuid NOT NULL REFERENCES data_tables(id) ON DELETE CASCADE,
  key_hash    text NOT NULL,
  key_enc     text NOT NULL,
  values_enc  text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- who changed it last: a person in the portal, or a run
  updated_by  uuid REFERENCES members(id) ON DELETE SET NULL,
  updated_run uuid,
  UNIQUE (table_id, key_hash)
);
CREATE INDEX data_rows_table ON data_rows (table_id, updated_at DESC);

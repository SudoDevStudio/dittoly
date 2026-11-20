-- Table steps' claim (src/tables/service.ts): one run holds a row's key until it ends or `until` passes. Of runs that
-- claim the same key at the same time exactly one gets it; a claim lapses, so a run that died does not hold it for ever.
CREATE TABLE data_claims (
  table_id  uuid NOT NULL REFERENCES data_tables(id) ON DELETE CASCADE,
  key_hash  text NOT NULL,
  run_id    uuid NOT NULL,
  until     timestamptz NOT NULL,
  PRIMARY KEY (table_id, key_hash)
);

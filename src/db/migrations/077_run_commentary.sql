-- What a run is doing, line by line ("Step 2: calling GitHub", "GET api.github.com/search/issues → 200"), so the
-- Live panel and the run page narrate it. Encrypted (a line can carry names); deleted with the run.
CREATE TABLE run_commentary (
  id       bigserial PRIMARY KEY,
  run_id   uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id  text,
  at       timestamptz NOT NULL DEFAULT now(),
  text_enc text NOT NULL
);
CREATE INDEX run_commentary_run ON run_commentary (run_id, id);

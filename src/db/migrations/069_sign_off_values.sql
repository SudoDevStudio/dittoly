-- A sign-off before a step that text an AI wrote could steer covers that step's exact values: what the step will do,
-- resolved when it starts to wait (encrypted, shown to the approver), and its hash. The decision records the hash the
-- approver saw; if the values differ when the step runs, the step asks again (src/engine/engine.ts).
ALTER TABLE run_steps ADD COLUMN sign_off_enc text, ADD COLUMN sign_off_sha256 text;
ALTER TABLE gate_decisions ADD COLUMN values_sha256 text;

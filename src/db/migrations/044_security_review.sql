-- A follow-up passed on what an AI wrote as this run's inputs: its writes wait for a sign-off.
ALTER TABLE runs ADD COLUMN inputs_from_model boolean NOT NULL DEFAULT false;

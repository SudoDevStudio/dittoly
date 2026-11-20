-- Evidence gates: a sign-off a fix step's verified change releases has no person deciding it.
-- decided_by is then NULL and auto_evidence holds the facts it was released on (no secrets, no code).
ALTER TABLE gate_decisions ALTER COLUMN decided_by DROP NOT NULL;
ALTER TABLE gate_decisions ADD COLUMN auto_evidence jsonb;
ALTER TABLE gate_decisions ADD CONSTRAINT gate_decisions_someone_or_evidence CHECK (decided_by IS NOT NULL OR (auto_evidence IS NOT NULL AND decision = 'approved'));

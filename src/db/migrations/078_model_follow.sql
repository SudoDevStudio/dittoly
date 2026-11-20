-- Flows follow the organization's AI model unless an approver locks a version to one (model_locked: its ai_model).
-- ai_model of a version that follows is only the model it was approved or last checked with. A run may be started
-- with a model of its own (runs.ai_model), unless its version is locked.
ALTER TABLE flow_versions ADD COLUMN model_locked boolean NOT NULL DEFAULT false;
ALTER TABLE runs ADD COLUMN ai_model text;

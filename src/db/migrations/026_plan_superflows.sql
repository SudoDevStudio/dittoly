-- Plans can reuse approved Flows as they are ('existing') and connect the plan's
-- Flows into a Super Flow ('superflow'), drafted once every Flow it runs is approved.
ALTER TABLE plan_items DROP CONSTRAINT plan_items_kind_check;
ALTER TABLE plan_items ADD CONSTRAINT plan_items_kind_check CHECK (kind IN ('module', 'flow', 'existing', 'superflow'));

-- AI work into Flows: AI assistants save what they did as draft Flows (and modules) over MCP.
ALTER TABLE module_versions DROP CONSTRAINT module_versions_origin_check;
ALTER TABLE module_versions ADD CONSTRAINT module_versions_origin_check CHECK (origin IN ('chat', 'seed', 'mcp', 'script', 'assistant'));

-- What doing a Flow's task with AI cost once (tokens), the baseline for "saved by not asking an AI every time".
-- assistant: reported by the assistant that saved it; drafting: tokens Dittoly's AI used to draft it; owner: set by its owner.
ALTER TABLE flows ADD COLUMN ai_baseline_input_tokens integer CHECK (ai_baseline_input_tokens >= 0);
ALTER TABLE flows ADD COLUMN ai_baseline_output_tokens integer CHECK (ai_baseline_output_tokens >= 0);
ALTER TABLE flows ADD COLUMN ai_baseline_provider text;
ALTER TABLE flows ADD COLUMN ai_baseline_model text;
ALTER TABLE flows ADD COLUMN ai_baseline_source text CHECK (ai_baseline_source IN ('assistant', 'drafting', 'owner'));

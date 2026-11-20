-- Browser modules made from a pasted Playwright script (origin 'script').
ALTER TABLE module_versions DROP CONSTRAINT module_versions_origin_check;
ALTER TABLE module_versions ADD CONSTRAINT module_versions_origin_check CHECK (origin IN ('chat', 'seed', 'mcp', 'script'));

-- Phase 1: MCP servers imported as modules (origin 'mcp').
ALTER TABLE module_versions DROP CONSTRAINT module_versions_origin_check;
ALTER TABLE module_versions ADD CONSTRAINT module_versions_origin_check CHECK (origin IN ('chat', 'seed', 'mcp'));

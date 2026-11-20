-- Phase 1: organization marketplace (this server only).

CREATE TABLE marketplace_listings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('module', 'flow_template')),
  -- kind = module: the module name; the listing always offers the latest approved version.
  module_name      text,
  -- kind = flow_template: one exact approved Flow version.
  flow_version_id  uuid REFERENCES flow_versions(id),
  title            text NOT NULL,
  summary          text NOT NULL,
  tags             text[] NOT NULL DEFAULT '{}',
  published_by     uuid NOT NULL REFERENCES members(id),
  published_at     timestamptz NOT NULL DEFAULT now(),
  deprecated_at    timestamptz,
  CHECK ((kind = 'module') = (module_name IS NOT NULL)),
  CHECK ((kind = 'flow_template') = (flow_version_id IS NOT NULL))
);
CREATE UNIQUE INDEX marketplace_one_listing_per_module ON marketplace_listings (module_name) WHERE kind = 'module';
CREATE UNIQUE INDEX marketplace_one_listing_per_template ON marketplace_listings (flow_version_id) WHERE kind = 'flow_template';

-- Where a Flow came from, when it was created from a template.
ALTER TABLE flows ADD COLUMN template_listing_id uuid REFERENCES marketplace_listings(id);

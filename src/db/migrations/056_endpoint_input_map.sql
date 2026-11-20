-- A Flow URL can map the posted JSON onto the Flow's inputs (input name -> JSON Pointer, "" for the whole body),
-- as webhook triggers do, so a sender's own payload starts the Flow without changing either side.
ALTER TABLE flow_endpoints ADD COLUMN input_map jsonb;

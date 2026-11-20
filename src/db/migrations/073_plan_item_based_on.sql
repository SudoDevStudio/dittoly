-- What a plan item builds on instead of a draft from scratch: "extends:<module>" (the next version of an approved
-- module, keeping its actions), "example:<folder>" (a module that ships with Dittoly, loaded for review) or
-- "template:<file>" (a Flow template that ships with Dittoly). NULL: the AI drafts it (src/plans/service.ts).
ALTER TABLE plan_items ADD COLUMN based_on text;

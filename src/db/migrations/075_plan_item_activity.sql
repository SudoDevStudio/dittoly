-- What the AI is doing right now while it drafts a plan item, so the plan and the live build panel never look stuck:
-- when the current step started, and the AI's latest activity within it (a web search, a thought), encrypted like the
-- item's request since it can echo it. Cleared when drafting ends (src/plans/service.ts, src/core/progress.ts).
ALTER TABLE plan_items ADD COLUMN progress_at timestamptz, ADD COLUMN progress_detail_enc text, ADD COLUMN progress_detail_at timestamptz;

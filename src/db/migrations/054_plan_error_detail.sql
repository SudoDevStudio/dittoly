-- Why a plan's analysis failed (for example which part of the AI's answer did not fit), encrypted like the rest of a plan.
ALTER TABLE plans ADD COLUMN error_detail_enc text;

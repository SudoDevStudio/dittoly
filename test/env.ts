/**
 * The drafting-time review round (DITTOLY_AI_DRAFT_REVIEW, on by default) sends the AI one more request whenever
 * Dittoly's own review of a draft finds something, which would consume the next canned answer in tests that queue
 * one per draft. It is off here and turned on by the tests that are about it (test/draft-review.test.ts).
 */
process.env.DITTOLY_AI_DRAFT_REVIEW ??= 'off';

# Plans from a PDF

A member uploads a plan (a PDF describing what they want automated) on the **Plans from PDF** page. Dittoly then:

1. **Reads the text.** The text is extracted on the server with [unpdf](https://github.com/unjs/unpdf). A PDF made of scanned images has no text. Dittoly refuses it with a message to export the document again or run text recognition (OCR) on it first; it does not run OCR itself. Files are limited to 10 MB.
2. **Has the organization's AI break it down.** The AI sees the plan's text, fenced off as data, along with the actions of the approved modules and the organization's AI instructions. It returns:
   - a short summary;
   - the questions it cannot decide on its own (which chat tool, who approves, how often...);
   - the new modules to build, reusing approved modules wherever they already cover something;
   - the Flows to draft, each listing the new modules it needs.

   The AI reads at most the first 60,000 characters of the plan.

   The AI knows Dittoly's built-in steps (approval, form, delay, data tables, AI, browser checks, building an app,
   fix-and-verify in a sandbox, reports, running another Flow) and what can start a Flow (a person, a schedule,
   webhooks, Flow URLs, watches, email, file drops). It proposes a module only to reach an outside app or service,
   or for logic none of the approved modules has.

   When the AI's answer goes over a limit, the text is cut to the limit (a title to 120 characters, a request to
   4,000), extra entries are dropped, and an entry that does not fit is left out. An answer that cannot be used at all
   is sent back to the AI once, saying what was wrong. If the second answer cannot be used either, the plan fails with
   **ai_invalid_plan**, and the plan page shows the reason under **Details**.
3. **Asks its questions.** When there are questions, the plan waits and the uploader is notified. Their answers, or "Let the AI decide", go back to the AI. The same answers are then given to every module and Flow drafted from the plan, so nothing asks again.
4. **Drafts the modules and sends them for review.** Each module is built by the usual module builder and validated in the sandbox.
   - **Adding to an approved module.** When a plan needs actions an approved module lacks, it says so ("adds to
     slack"). The module's next version is written from its current manifest and code and keeps every action it has;
     it is reviewed like any version. If that module is not approved (any more), a new module is drafted instead.
   - A draft whose own sandbox tests or checks fail goes back to the AI with what failed, twice at most, before it is
     stored. Mechanical slips in the manifest (an over-long description, a URL where a host belongs) are fixed
     without asking the AI.
   - A draft that passes its tests is submitted for admin review straight away.
   - A draft that still fails its tests stays a draft, marked **needs fixing**; the uploader revises it on the module page.
   - When the AI service is busy, unreachable or fails on its side, the item is tried again later (after 30
     seconds, 2 minutes and 5 minutes) before it is marked failed.
5. **Drafts each Flow once its modules are approved.** When an admin approves a module, every plan waiting on it moves on. A Flow whose modules are all approved is drafted by the usual Flow builder, in the team chosen at upload. Like any Flow, it is pending until an approver approves it.
   - When the Flow builder finds that approved modules lack something the Flow needs (an action a module does not
     have yet), the plan adds it: a module item that adds the actions to the module the AI named (or a new module),
     and the Flow waits for it, like any Flow waits for its modules. What is missing comes from the check before
     drafting and from the Flow builder itself, which names the actions it lacks (an exact filtering or matching step
     can be an action that calls no app). This happens at most twice per Flow, never for the same part twice; after
     that the Flow fails with the AI's reason.
   - **Details you added** to an item can be edited or removed; the next **Try again** drafts without removed ones.
   - If a module is rejected, fails, fails its tests or is cancelled, the Flows that need it are **blocked**. The
     Flow says which module it waits on and why.
   - Trying that module again (or resuming it) puts those Flows back to waiting.
   - A revised version of a module keeps its name, and approving it unblocks those Flows.

6. **Reuses approved Flows.** The AI also sees the approved Flows the uploader can use. When one already does part of the plan, nothing new is built for it: it is listed under **Reusing existing Flows**, with one sentence on why it fits. The server keeps only Flows that exist, are approved and are visible to the uploader.
7. **Suggests a Super Flow.** When the plan's processes belong together (one leads to the next, or several react to the same event), the AI proposes a **Super Flow** connecting the new and the reused Flows.
   - It waits until every Flow it runs is approved; the plan follows each Flow's approval, including approved revisions.
   - It is then drafted, pinned to exactly those versions, and needs its own approval.
   - If one of its Flows is rejected, it is blocked until a revised version is approved.

Nothing a plan drafts can run until people approve it: the modules need an admin and the Flows need an approver, exactly as when they are built through chat.

## Who sees what

- Any member can upload a plan.
- A plan is visible only to the member who uploaded it and to admins. For anyone else it reads as not found.
- Only the uploader answers a plan's questions.
- The PDF, its extracted text, the AI's breakdown, the answers and each item's request are stored encrypted with the master key. Rotating the key covers them.
- The PDF can be downloaded again from the plan page.
- Deleting a plan deletes the PDF and the text. The modules and Flows it drafted stay.

## Statuses

| Plan | Meaning |
|---|---|
| reading | The AI is reading the plan. |
| needs answers | The AI asked questions; the uploader answers on the plan page. |
| drafting | Modules or Flows are being drafted. |
| waiting | Waiting on people: module reviews, or a module that needs fixing. |
| done | Every module is approved and every Flow is drafted; the Flows wait for an approver. |
| failed | The AI could not read the plan or found nothing to build; **Try again** reads it again. |
| cancelled | The uploader cancelled it. Nothing more is drafted; each module or Flow can be resumed on its own. A plan cancelled while it was being read can be read again with **Try again**. |

## Cancelling

- **Cancel** on a module or Flow stops it while it is queued, being drafted, waiting for its modules, blocked or
  waiting for answers.
- **Cancel plan** stops the reading, the questions and every module and Flow not yet finished.
- What is already drafted, in review or approved stays as it is.
- When the AI is writing a draft at the moment it is cancelled:
  - a module draft is kept as a draft and never sent for review;
  - a Flow draft is kept and linked from the item; it still waits for an approver, who can reject it.
- **Resume** (Try again) on a cancelled module drafts it again. A cancelled Flow waits for its modules again.
- Only the uploader and admins can cancel or resume.

A module draft whose AI answer cannot be read (broken or cut-off JSON) is asked for once more, as Flows are. If it
fails again, the item shows the reason.

The uploader is notified, in the portal and on their notification channels, in these cases:

- the plan has questions;
- something needs their attention (a draft failed its tests, a module was rejected, or drafting failed);
- the plan is done;
- the plan failed.

## API

| | |
|---|---|
| `POST /api/plans` | `{fileName, pdfBase64, title?, teamId?}`. Answers `201` with the plan. Refusals: `400 not_a_pdf`, `400 pdf_unreadable`, `422 pdf_has_no_text` (scanned), `503 ai_provider_not_configured`. |
| `GET /api/plans` | Your plans; admins see everyone's. |
| `GET /api/plans/:id` | The plan, its summary, open questions, answers, and items (modules and Flows, each with status and links). |
| `GET /api/plans/:id/pdf` | The uploaded PDF. |
| `POST /api/plans/:id/answers` | `{answers: {question: answer}}`. An empty object lets the AI decide. |
| `POST /api/plans/:id/retry` | Read a failed plan again (or one cancelled before anything was drafted). |
| `POST /api/plans/:id/items/:itemId/retry` | Draft a failed module or Flow again, or resume a cancelled one. |
| `POST /api/plans/:id/cancel` | Cancel the plan: everything not yet finished stops. `409 plan_not_cancellable` once it is done, failed or cancelled. |
| `POST /api/plans/:id/items/:itemId/cancel` | Cancel one module or Flow that has not finished. `409 plan_item_not_cancellable` otherwise. |
| `DELETE /api/plans/:id` | Delete the plan and its PDF. |

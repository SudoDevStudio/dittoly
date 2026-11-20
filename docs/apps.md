# Apps

An app is a set of pages over your team's approved Flows: forms, tables, cards, an inbox and a runs list. The whole
team opens it inside Dittoly, and you can export it later to run on its own.

Find it under **Apps** in the sidebar.

## How an app works

- **Shared by the team.** An app belongs to one team. Every member opens the same app at `/a/<app>/` and sees its
  runs and their results.
- **The team's keys.** Every run started from an app uses the team's shared credentials, so everyone gets the same
  results whoever clicks.
  - A Flow whose credential is set to each person's own key cannot run in an app.
  - The app's page lists what is missing: a team admin switches the credential to the team's shared key and stores
    it under **Teams**.
- **Approved versions.** Saving an app makes a new version, and an approver signs it off before the team sees it.
  - On a shared server, nobody approves their own app.
  - The approved version stays live until a newer one is approved.
  - Pending versions wait in the approvers' queue on the home page, like Flows.
- **The Flows' current approved versions, or a pinned one.** An app names its Flows; by default each runs at its
  current approved version, as in an export.
  - Editing a Flow ends its approved version's approval (as everywhere in Dittoly): until the new version is
    approved, apps following it say the Flow has no approved version.
  - **Before a new version is approved**, its review lists the apps using the Flow: which pages of each app's live
    version it breaks (an input renamed, a step a page reads removed), and which apps pin another version. Approving a
    version that breaks pages needs the approver to tick that they accept it; that is recorded in the audit log
    (`flow.app_breaks_accepted`).
  - **Pinning** (the app editor's version menu per Flow): the app runs that approved version and keeps its pages as
    they are. Once a newer version replaces it, the app still starts runs on it, but **only its read steps run**: a
    step that changes data stops with `pinned_version_retired` and the app's page says to move the pin. Nothing but
    a pinned app can start a replaced version. A pending or rejected version cannot be pinned. Exports use each Flow's
    current approved version.
  - Approved Flows keep their own approvals: an app adds pages, not permissions.
- **Ordinary runs.** A run started from an app is an ordinary run: same sandbox, broker, approvals, automatic stops
  and audit. The person who started it fills in its forms; approvers sign off its approval steps from the app's
  inbox page or from Dittoly.

## Building one

1. **Pick the Flows.** Choose the team's approved Flows the app runs.
2. **Make the layout.**
   - Without a description, you get the plain layout: a page per Flow.
   - With a short description ("an order desk: product cards with a Buy button, then checkout") and/or a sketch or
     screenshot, the organization's AI drafts the pages from the Flows and their modules' output shapes.
   - The AI only writes the page plan, never code. The plan is checked against the Flows.
3. **Edit it.**
   - Change titles, addresses, intros, the button, what a form's result shows, table or cards, and the order of
     pages. Add or remove pages.
   - Choose the main and accent colours, the font and the corners.
   - **Edit as JSON** reaches everything else: card fields, table columns, item buttons that open another page with
     fields filled in.
   - A sketch beside the editor follows every change.
4. **Save.** The saved version opens in the app's page as a real preview, drawn by the same code an exported app
   uses. Runs started from a preview are real and use the team's keys.
5. **Approve.** An approver approves the version; **Open app** opens it for the team.

## Exporting

**Export** on an approved app (admins and approvers) opens **Export an app** with the app's Flows, layout and look
filled in. The built-in UI ("API + simple UI") uses the app's own layout, so what the team used is what ships.
Choose a framework to get the same pages as a React, Next.js, Angular, Astro or Vue project instead. See
[app-export.md](app-export.md).

## Security

- **Same pages as an export.** The pages are drawn by the export's own renderer (`/app-ui/render.js`).
  - It renders text only: nothing a Flow returns is inserted as HTML.
  - It runs under Dittoly's content security policy.
- **Framing.** Only Dittoly itself may frame an app's pages, for the preview.
- **Access.**
  - Every call goes to `/api/apps/<app>/v/<version>/api/...` with the member's session.
  - Only members of the app's team (and org admins) can open an app, and only its own runs are reachable through it.
  - A version that is not approved opens only for its author and approvers.
- **Deleting** an app archives it: it stops opening, and its versions and runs are kept.

# Git sync

Dittoly can write what people approve to a git repository, so changes are reviewed, kept and rolled back the way
the rest of your code is. Nothing is synced until a repository is connected.

## What is written, and when

- **On approval.** When a module, Flow, Super Flow or app version is approved, Dittoly writes it on a branch of its
  own and opens a pull request (GitHub) or merge request (GitLab).
  - Other git hosts get the branch pushed; open the request there.
  - Rejected and pending versions are never written.
- **Export everything approved now** writes every currently approved item as one pull request: the first sync, or
  catching up after connecting.
- **Only files that changed.** When the files already match the branch, nothing is written ("Already up to date").
- **Never written:** approvals, run history, inputs, outputs and secrets. Only what was approved: module manifests,
  code and sandbox tests; Flow definitions; app layouts and looks. "Export everything approved now" also writes the
  repository's TypeScript project (see [Working on modules in the repository](#working-on-modules-in-the-repository)).

## Where it goes

- **The organization** connects one repository (**Members & Access → Git sync**, admins).
- **A team** may connect its own (**Teams → the team → git**, the team's admins). Its Flows, Super Flows and apps go
  there; without one, they go to the organization's.
- **Modules** belong to the organization, so they always go to the organization's repository.

## Layout

Under the folder you choose (`dittoly/` by default):

```
modules/<name>/manifest.json   module.ts   tests.json   MODULE.md
flows/<team>/<flow>/flow.json   FLOW.md   a Flow or Super Flow
apps/<team>/<app>/app.json      an app's Flows, page layout and look
README.md  package.json  tsconfig.json  types/  schemas/  scripts/  .vscode/   written by "Export everything approved now"
```

- **Modules:** a module's code is TypeScript (`module.ts`), as Dittoly's AI writes it. A module written before modules
  were TypeScript (or written as JavaScript) has `module.mjs` instead, until a version with TypeScript replaces it; the
  export then removes the old `module.mjs`. A module folder has one of the two, never both.
  `module.ts` starts with the Dittoly base, between `// <dittoly-base>` markers: the same tested TypeScript in every
  module (requests, credentials, paging, errors, queries, email, publishing, streams; see
  [module-types.md](module-types.md)). The module's own code is under it. Change the code under the base; a new
  version gets the current base again and keeps that code.
- **MODULE.md and FLOW.md** say what a module's actions do (read or write, inputs, outputs) and what a Flow does step
  by step; a Super Flow's FLOW.md covers every Flow it runs and the modules under them. Dittoly writes them from
  the approved version, with the builder's notes, and the AI reads them when it builds on that module or Flow.
  They are read only: changes to them are not read back.

- **Flows:** a Flow file uses the same format as **Export JSON** on a Flow's page (`format: "dittoly-flow"`).
- **Super Flows:** a Super Flow also lists the Flows it runs under `children`, by name and team as well as id, so it
  stays readable outside Dittoly.

## Connecting

| Host | Repository URL | Token |
| --- | --- | --- |
| GitHub (and GitHub Enterprise Server) | `https://github.com/acme/automations` | Fine-grained token with **Contents** and **Pull requests**: read and write |
| GitLab (and self-managed) | `https://gitlab.example.com/acme/automations` | Project or group token with the `api` scope |
| Other git over HTTPS | `https://git.example.com/acme/automations.git` | A token the host accepts over HTTPS |

- **Checked first:** Dittoly checks the token against the repository and branch before it keeps it.
- **Stored encrypted:** the token is encrypted with the master key (and rotated with it) and is never shown again.
- **Outbound rules:** requests follow Dittoly's usual outbound rules. A host on a private address must be listed in
  `DITTOLY_INTERNAL_HOSTS`.
- **Failures:** each export is listed on the card with its pull request link. A failed one shows why and has
  **Retry**.

## From git back to Dittoly

Changes merged into the connected branch come back as **new versions that wait for approval in Dittoly**. Git
never approves anything. Dittoly reads the branch every 10 minutes; **Sync from git now** reads it at once.

- **Changed Flow or Super Flow:** a new pending version, recorded as its owner's.
  - The approved version keeps running until the new one is approved, as with a self-fix.
  - While another change waits, the file is held back. The branch is read again every 10 minutes, without a new
    commit, and the file becomes a version once the waiting change is decided.
  - A Super Flow that runs a Flow not here yet is held back the same way, until that Flow arrives.
- **Changed app:** a new pending version. Its live version stays live.
- **Changed module:** a new module version. A change to its code, its manifest or only its `tests.json` counts.
  - Dittoly compiles `module.ts` itself, with the same compiler and options as the repository's `npm run build`.
    The version keeps both; the TypeScript is what people read, the compiled JavaScript what runs. A `module.ts` that
    does not compile is listed with the compiler's message and line, and nothing is created.
  - A folder with both `module.ts` and `module.mjs` is listed as a problem: keep only `module.ts`.
  - It is tested in the sandbox and sent for an admin's review.
  - It gets a higher version number than any Dittoly already has, whatever the file says.
  - If its tests fail, it stays a draft.
- **New files:**
  - A new Flow or app is created pending, recorded as the person who connected the repository.
  - A new module is drafted and sent for review.
- **Deleted files** delete nothing.
- **Each change is handled once.** Dittoly remembers what it last handled for each file (a module's folder counts
  as one). Reading the same branch again does nothing.
- **What Dittoly wrote itself never comes back.** When Dittoly's own pull request is merged, the file matches the
  version Dittoly has, or a newer one: that is not a change. On the first read, a file that matches any version
  Dittoly has is skipped.
- **Going back to an older version on purpose** (for example `git revert`) is a change: it becomes one new pending
  version with that content. The old version's approval never carries over.
- **Plain git hosts:** the files read are those of the commit actually checked out, even if the branch moved
  while reading.
- **Scope:** a team's repository changes only that team's Flows and apps. The organization's repository changes
  modules, and the Flows and apps of teams without a repository of their own.
- **Super Flows:** a Flow's id is used when it exists here. Otherwise its name and team from `children` are used.
- **History:** each read that found something is listed under **From git** on the card. It shows the versions now
  waiting for approval and any file that could not be used, with the reason.

Anyone who can push to the branch can propose changes this way. They still need approval in Dittoly, and on a
shared server nobody approves their own. A change proposed for a Flow is recorded as the Flow owner's, so the owner
cannot approve it either.

## Working on modules in the repository

"Export everything approved now" makes the folder a small TypeScript project:

```sh
cd dittoly            # the folder you chose
npm install
npm run check          # type-checks every module.ts against Dittoly's runtime types
npm run build          # compiles them the way Dittoly does, to dist/modules/<name>/module.mjs
npm run build -- --js  # the same, named module.js
```

- **`types/dittoly.d.ts`:** the types of what a module's actions get: `ModuleContext` (`ctx.http.request`, the
  other protocols, `ctx.settings`, `ctx.ActionError`, browser pages) and `ModuleActions`. They are global, because
  module code may not import anything.
- **`npm run build`** uses the same esbuild version and options as Dittoly, so `dist/` holds exactly the JavaScript
  Dittoly would run. It is for running or testing modules outside Dittoly; Dittoly never reads `dist/`
  (`.gitignore` leaves it out) and compiles `module.ts` itself.
- **Type checks** are the repository's: Dittoly only removes types when it compiles; it does not check them. Run
  `npm run check` in your own CI if you want pull requests checked.
- **`schemas/`:** JSON Schemas for `manifest.json`, `tests.json`, `flow.json` and `app.json`. `.vscode/settings.json`
  applies them in VS Code when you open the folder; other editors can use the files directly.
- **Rewritten on export:** `README.md`, `package.json`, `tsconfig.json`, `types/`, `schemas/`, `scripts/` and
  `.vscode/settings.json` are Dittoly's. "Export everything approved now" writes them again, so changes made to
  them in git do not last.

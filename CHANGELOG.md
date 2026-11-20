# Changelog

What changed for the person using Dittoly, newest first. Entries that only move code around are left out.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0.0 a minor version can change behaviour:
read the entry before upgrading.

## Unreleased

## 0.1.0 — 2026-11-20

The first numbered release. Everything described in the README and `docs/` is in it: modules, Flows and Super
Flows, approvals that freeze an exact version, per-member credentials and delegation, the two sandbox backends,
the audit chain and its streams, apps and app export, MCP, plans from a PDF, git sync, and the error-to-fix
workflow across nine language toolchains.

It has not been run against real Jira, GitLab or Slack accounts, or a real identity provider — see the status
note in [docs/README.md](docs/README.md). Treat it as a first release to try on your own server, not as something
to point at production unattended.

### Added

- **How a Flow or a module came to be what it is.** What a person asked for is kept with the artifact — their own
  words, what an approver decided, what the checks found, and, marked as such, what an AI suggested. A revision is
  given the original request and the constraints that still hold, so it cannot quietly drop them; an AI's own
  suggestion is never handed back as a rule. Entries are superseded or deleted, never rewritten, and each version
  records which ones it was drafted with.
- **What a team already answered.** Answers given while drafting ("which channel?", "which project?") are kept for
  the team and offered to the next draft instead of being asked again, scoped to the apps in play. An answer given
  in the current request wins, and a team can read and forget them on the Teams page.
- **A model per Flow, module, plan and member.** Whoever drafts can choose which AI writes what, falling back to the
  member's choice and then the organization's.
- **Links from a missing credential to the page that stores it**, with that page marking out the form it opened for
  and saying which app a Flow is waiting for.

### Changed

- **A failing AI command-line provider says what it said.** Its own last message and exit code are kept with the
  error and shown under Details, with anything shaped like a key, token or authorization header removed first.
- **Data an app or a webhook sends is treated as untrusted**, but only where it would decide a destination or
  something to execute — not for every value it touches.

### Security

- Prompt-injection containment now covers app data and webhook payloads, with the influence a value has at a step
  deciding whether a sign-off is required.
- **A website**, published from `site/` to GitHub Pages, and `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` and issue
  templates for people who want to take part.

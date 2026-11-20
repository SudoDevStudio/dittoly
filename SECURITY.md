# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub: on this repository, open **Security → Report a vulnerability**. Include what is
affected, how to reproduce it, and what an attacker could do. You will get an answer within a few working days, and we
will agree on a date to publish the fix and the advisory together.

Areas we care most about:

- escaping a sandbox (module code, browser steps, app and fix steps) or reaching hosts a step did not declare;
- reading or using another person's credentials, or running as someone else;
- changing what an approval covers (a version, a module, a Flow) without a new approval;
- tampering with the audit log without it being detected.

## Supported versions

Fixes go into the `main` branch and the next release. Run the latest release.

## Running Dittoly safely

See [docs/server.md](docs/server.md) for production setup (a host dedicated to Dittoly, HTTPS, single sign-on, the
master key kept apart from the database) and [docs/governance.md](docs/governance.md) for approval rules and the audit
log.

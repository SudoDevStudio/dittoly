# Watches: start a Flow for each new thing

A **watch** looks somewhere every few minutes (1 minute to 7 days) and starts its Flow once for each new item, as the person who set it up. They are added on an approved Flow's page under **Watches**.

| Kind | Looks at | Inputs can use |
|---|---|---|
| **New items in an app** | what an approved **read** action returns (new Jira issues, new merge requests, ...), with your own access | `{{ item.<field> }}` |
| **New emails** | a mailbox over IMAP (TLS on 993, or STARTTLS) | `{{ email.from }}`, `{{ email.to }}`, `{{ email.subject }}`, `{{ email.text }}`, `{{ email.date }}`, `{{ email.messageId }}` |
| **New files** | a folder (prefix) in an S3-compatible bucket: AWS S3, MinIO, Cloudflare R2, ... | `{{ file.key }}`, `{{ file.size }}`, `{{ file.lastModified }}`, `{{ file.etag }}`, and with "give the Flow the text" `{{ file.text }}` for text files up to 256 KB |

**How it behaves:**
- **The first look only remembers what is already there.** Nothing old starts a run.
- Then each new item starts one run. Each item is run once (items are remembered by key: the app item's field, the email's UID, the file's key and ETag). At most 20 runs start per look; the rest come on the next look.
- Runs go through the usual checks: the Flow must still be approved, and organization rules (working hours, daily limits) apply. A watch whose Flow loses its approval turns itself off and tells its owner.
- A look that fails (wrong password, no access, unreachable) is shown on the watch. The owner is told when it starts failing, not on every look.
- **Check now** looks once right away. Watches can be turned off and on, and removed.

**Safety:**
- Only actions that **only read** can be watched, since they run again and again.
- Email is opened **read-only** (IMAP EXAMINE): nothing is marked read, moved or deleted. The server's address must pass the same rules as module traffic: private addresses only when an admin listed the host in `DITTOLY_INTERNAL_HOSTS`.
- File watches use HTTPS and sign every request (AWS Signature Version 4, checked against AWS's published test vectors). Give them a key that may only list and read that bucket.
- Passwords and secret keys are stored encrypted and never shown again.
- Email bodies and file text become the run's inputs, which are encrypted and kept for the run retention period like any run's inputs.

**Not yet tried against a real mail server or bucket.** The IMAP side uses the `imapflow` library and was tested with a fake mailbox; the S3 side was tested with a fake bucket.

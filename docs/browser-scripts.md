# Browser scripts (Playwright)

A browser script is a Super-Module with a `browser` section. Its code drives a
headless Chromium through `ctx.page` and `ctx.expect`, a subset of Playwright
with the same names. Use it to test a website (for example after a release
Flow) or to work with a site that has no API.

## Making one

- **Paste a script** (Modules → *Paste a Playwright Script*). Each
  `test(...)` becomes an action; a plain script becomes one action, `run`. The
  browser may open only the sites the script visits, plus any you add (CDNs).
  Each action is run once against those sites as its sandbox test, and returns
  `{ passed, url, screenshot }`. Pasted scripts may not run JavaScript in the
  page, intercept requests, upload files or sign in; build those with the AI.
- **Describe it to the AI.** It writes the module and offline tests that answer
  the browser from canned HTML. A login is a credential in the member's vault,
  typed with `locator.fillSecret('login', { part: 'password' })`.

Either way an admin reviews the module before a Flow can use it.

## Using it in Flows

A browser action is an ordinary step: after another action, before an approval,
inside `forEach`. To run a whole Flow after another one finishes, add a
follow-up on the first Flow's page (*Then run another Flow*). It runs as you,
after your own runs only, with inputs such as `{{ inputs.project }}` or
`{{ steps.<id>.output.<field> }}` from the finished run. Follow-ups that start
follow-ups stop after three in a row.

## What the runtime enforces

- The script never holds the browser. Every call is a plain-data request that the
  broker checks and a browser driver (`sandbox-runtime/browser-driver.mjs`)
  carries out.
- Pages load only the declared hosts. Each request and WebSocket is checked, and
  all browser traffic also goes through the Dittoly egress proxy, which refuses
  other hosts and private addresses (unless listed in `DITTOLY_INTERNAL_HOSTS`;
  plain `http` only for hosts in `DITTOLY_INSECURE_HTTP_HOSTS`, local mode).
  Navigating to another host fails the step as a violation; other blocked
  requests are reported in the test report.
- A secret is typed only into a page on the credential's own hosts, and anything
  the browser returns has typed secrets blanked out (`••••••`), also when the
  page holds them URL-encoded, form-encoded or HTML-escaped.
- A field a secret was typed into (`fillSecret`, or typed by the member during
  `askForHelp`) is sealed for the rest of the action: the script can click it,
  check it is visible and submit it (Enter, or the form's button), but reading
  it (`inputValue`, `getAttribute`, texts), editing it (`fill`, `clear`, other
  keys) and value or text expectations on it fail with `browser_secret_field`.
  Once a secret is in the session, expectations take no regular expressions
  (`browser_secret_pattern`): use plain strings. Screenshots mask sealed fields,
  and are refused (`browser_secret_field`) while a secret shows in the page.
- WebRTC is switched off (its UDP traffic would not go through the proxy).
- No file is written: no downloads, uploads or screenshot paths. Screenshots come
  back as JPEG data URLs and show as images in the run view (at most 10 per action).

## Live pages in run views

A URL output on one of an approved browser module's sites (for example the
`url` a pasted script returns) is shown as the live page, in a sandboxed frame,
above the screenshot. It loads fresh in the viewer's own browser, so it may
differ from what the script saw, and the viewer may need to sign in. Many sites
refuse to be shown inside other pages (X-Frame-Options or CSP frame-ancestors);
those frames stay blank and the screenshot is the record. The portal's
Content-Security-Policy allows framing exactly these sites (https; plain http
only for hosts in `DITTOLY_INSECURE_HTTP_HOSTS`), and nothing else.

## Where the browser runs

| Sandbox | Browser |
| --- | --- |
| `process` (local) | Chromium on this machine. Set `DITTOLY_BROWSER_PATH`, or install Playwright's browser for the installed `playwright-core`. |
| `docker` (shared) | The Playwright image (`DITTOLY_BROWSER_IMAGE`, default `mcr.microsoft.com/playwright:v<playwright-core version>-noble`) on an internal network of its own session (removed when the session ends); its only way out is that session's egress proxy container. The server's own `playwright-core` is mounted read-only so client and browser versions match. |

## Live browser

While a browser step runs, its member sees it live on the run page (only the
member the run runs as; nobody else can see or reach the session). The page is
streamed from the server's Chromium, so this works for every site, including
ones that refuse to be shown inside other pages.

- **When the script asks for help.** `await page.askForHelp('Sign in, then press
  Continue')` makes the run wait (the member is notified). The member clicks and
  types in the live view, then presses Continue and the script carries on. The
  step's time limit is paused while it waits, for up to 15 minutes; an action may
  ask at most twice, and takes at most 30 minutes in all, waits included
  (`help_limit_reached`). What the member types is added to the secrets that are
  blanked out of anything the script reads back, and the field they typed into is
  sealed. A running script's page cannot be driven otherwise. Sandbox
  tests skip `askForHelp`.
- **Dittoly Browser** (*open it in the Dittoly browser* next to a live page
  link, or `/browser`; it is not in the sidebar). Open a page, browse it, and
  take screenshots to download. It opens the sites of approved browser modules
  and the **allowed sites** an admin lists on that page (`example.com`, or
  `*.example.com` for every site under it; changes are audited). The page lists
  them all as one-click links. A browser module's script still opens only the
  sites its own reviewed manifest declares. A member can have two pages open at
  a time, and each closes five minutes after its last viewer leaves.

Frames stream over Server-Sent Events (`GET /api/live/:id/stream`) only while
someone watches; input goes to `POST /api/live/:id/input`. Sessions live in the
server process that runs the step, so a shared deployment with several app
instances needs requests for a run routed to the instance running it.

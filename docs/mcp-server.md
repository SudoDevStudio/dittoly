# Dittoly as an MCP server

AI assistants that speak the Model Context Protocol (Claude Code, Claude Desktop, Cursor and others) can run your approved Flows as tools. The AI builds the Flow once; after that the assistant just calls it, and every run follows the approved version.

## What an assistant can do

- **Run a Flow** that its owner offered to AI assistants. Each such Flow is one tool, named `run_<flow name>_<6 characters of its id>`, whose input is the Flow's run form. The tool description says whether the Flow changes data, and the tool's hints say so too (`readOnlyHint` / `destructiveHint`), so the assistant can ask you first.
- **Check a run** with `get_run` and its run id: status, each step's result and, for your own runs, the outputs.

It runs as **you**, with your own access (or your team's shared keys), exactly as if you had pressed Run. Organization rules (working hours, daily limits) apply. Sign-offs and forms still wait for a person in Dittoly; the tool answers that the run is waiting, and `get_run` shows when it moves on. An assistant cannot approve anything or change an approved Flow, and never sees your stored keys. It can save new drafts for people to review: see below.

## Save AI work as a Flow

The point of Dittoly is that a task you once asked an AI to do becomes a Flow that runs again and again without an AI and without spending tokens. When an assistant has just done a task for you, ask it to **save this as a Flow**:

1. It calls `get_flow_guide`. This returns Dittoly's drafting rules (the [`save-ai-work`](../skills/save-ai-work/SKILL.md) skill and the Flow skills), your teams, and what a Flow can use: approved app actions with their input and output schemas, approved Flows, and your team's data tables. Your organization's AI instructions are included too. With `"newModules": true` it also returns the module rules.
2. It drafts the Flow from the steps it actually took. Values that change from run to run become the run form, it puts a sign-off before changes, and it adds a test made from what the apps answered. If no approved module can do a step, it also drafts a module for that app.
3. It calls `save_as_flow`. Dittoly checks everything:
   - new modules run their sandbox checks and tests;
   - the Flow is checked against the catalog and the definition rules;
   - the assistant's tests are played against the Flow.

   If anything fails, **nothing is saved** and the assistant gets the problems to fix. When everything passes:
   - the Flow is saved as a pending version (a new Flow, or a new version of one you own with `flowId`);
   - new modules go to admins for review (a module version already taken is renumbered, in the Flow too);
   - the tests are kept with the Flow.

   The assistant gets the links to give you.
4. People review and approve as usual. Reviewers see who drafted it (the assistant's name, as it gave it, and the MCP token it used) and the assistant's explanation. Until the new modules and the Flow are approved, it cannot run.

The assistant does the drafting with its own model, so **your organization spends no tokens on it**, and nothing goes to the organization's AI provider. The assistant may report what doing the task cost it (`aiUsage`: input and output tokens, provider, model). That is kept with the Flow as the baseline for the savings Dittoly shows. Each save is an audit event (`mcp.flow_saved`).

## Turning it on

1. **Offer a Flow:** on the Flow's page, the owner (or a team or org admin) clicks **Offer to AI assistants**. Only its approved version is offered; a new version is offered once it is approved. Turning it off removes the tool at once.
2. **Make an agent:** on the **AI Agents** page, give it a name ("Claude Code on my laptop"), pick the Flows it may use and how long it works (90 days unless you change it), and copy its token; it is shown once. A token only works for MCP, not for the rest of the API, and can be revoked any time.
3. **Connect the assistant** to `https://<your Dittoly>/mcp` (Streamable HTTP) with the header `Authorization: Bearer <token>`. For Claude Code:

   ```sh
   claude mcp add --transport http dittoly https://dittoly.example.com/mcp --header "Authorization: Bearer dty_mcp_..."
   ```

   Assistants configured with a JSON file use `{"mcpServers": {"dittoly": {"type": "http", "url": "https://dittoly.example.com/mcp", "headers": {"Authorization": "Bearer dty_mcp_..."}}}}`.

The audit report lists runs started this way as *via AI assistant (MCP)*, and each token's last use is shown next to it.

## Connect by signing in (Claude, ChatGPT, Copilot Studio)

Apps that add MCP servers as connectors in a browser, such as Claude.ai, ChatGPT and Microsoft Copilot Studio, connect by **signing you in** instead of a pasted token. Dittoly is the OAuth authorization server for its own `/mcp`.

**What admins must do first.** Nothing may connect by signing in until an admin allows it, under **Members & Access → Apps that may connect**:

- **Claude**: claude.ai on the web, Desktop, mobile and Cowork (they come back to `https://claude.ai/api/mcp/auth_callback`, or the same path on `claude.com`), and Claude Code (its metadata document `https://claude.ai/oauth/claude-code-client-metadata`, coming back to `http://localhost` or `http://127.0.0.1` on any port).
- **ChatGPT**: anything that comes back to `https://chatgpt.com/...` (ChatGPT's per-connector callback `https://chatgpt.com/connector/oauth/<id>`, and the older `https://chatgpt.com/connector_platform_oauth_redirect`).
- **Microsoft Copilot Studio**: anything that comes back to `https://global.consent.azure-apim.net/...` or another `*.consent.azure-apim.net` host (Power Platform adds the connector's name to the path).
- **Other apps**: by the URL of their client metadata document (their client id), or by the host they send people back to (`app.example.com`, `*.example.com`).

An app is recognized by **where it sends you back** (or, for a metadata document, by its URL), never by the name it gives itself: the code only ever goes to an allowed address. An app that is not allowed gets a page saying so, before anyone is asked anything. Switching an app off also stops its connections from refreshing their tokens.

**Dittoly must be on https.** Set `DITTOLY_PUBLIC_URL` to the address the apps reach, e.g. `https://dittoly.example.com`. The server URL you give the app is `<public URL>/mcp`, exactly; it is also the token audience. The hosted apps reach Dittoly from the internet (Claude from `160.79.104.0/21`), so the server, `/.well-known/*` and `/oauth/*` must be reachable from there.

**Connecting:**

- **Claude.ai / Desktop**: Settings → Connectors → Add custom connector, URL `https://dittoly.example.com/mcp`, no client id or secret. Claude Code: `claude mcp add --transport http dittoly https://dittoly.example.com/mcp`, then `/mcp` in Claude Code to sign in.
- **ChatGPT**: add a connector (developer mode or an app) with the URL `https://dittoly.example.com/mcp` and OAuth authentication.
- **Copilot Studio**: add a tool → Model Context Protocol, URL `https://dittoly.example.com/mcp`, authentication OAuth 2.0 with **Dynamic discovery**.

The app sends you to Dittoly (through your organization's sign-in if you are not signed in) and you see the **consent page**: the app's name, the host it will send you back to (in large type; with a warning when that is a program on your own computer), and the same choices as on the Agents page: which offered Flows and app actions it may use (*use directly* or *ask me first*), whether it may draft Flows, and for how long (1 day to a year). **Allow** makes an agent for you, listed on the Agents page with the app's name; **Deny** tells the app no. Revoking the agent there ends the connection at once.

How it works, for the people running it:

- Discovery: `/.well-known/oauth-protected-resource/mcp` (and `/.well-known/oauth-protected-resource`) names `<public URL>/mcp` and the issuer `<public URL>`; `/.well-known/oauth-authorization-server` lists `/oauth/authorize`, `/oauth/token`, `/oauth/register` and `/oauth/revoke`.
- Clients: a client id that is an https URL is read from its **client ID metadata document** (fetched through the egress guard, at most 10 KB and 5 seconds, cached for 10 minutes; its `client_id` must be its own URL, and it may not ask for a client secret). Apps without one register themselves (**dynamic client registration**, public clients only, rate-limited). Only public clients: there are no client secrets.
- The authorization code flow requires PKCE (S256), `state`, an exactly registered redirect URI (loopback addresses match on any port) and, when sent, `resource=<public URL>/mcp`.
- Codes work once, within 60 seconds. Access tokens last an hour (never past the agent's expiry). Refresh tokens rotate on every use; a used refresh token or code presented again revokes the whole connection and its agent (`mcp.oauth_token_reused` in the audit log). Only hashes of codes and tokens are stored.
- Audit events: `mcp.oauth_granted`, `mcp.oauth_denied`, `mcp.oauth_agent_created`, `mcp.oauth_grant_revoked`, `mcp.oauth_token_reused`, `mcp.oauth_app_refused`, `org.mcp_oauth_apps_updated`.

## Agents: what each assistant may use

Each MCP token is an **agent** acting for one person. It gets nothing until that person picks:

- **Tools.** Each Flow offered to assistants is either *not allowed*, *use directly*, or (for Flows that change data) *ask me first*. The assistant sees only the tools it was given; one it tries outside them is refused and recorded as *not allowed*.
- **Ask me first.** The call is not run. The assistant gets a `callId` and is told to check with `get_call`; the person gets a notification and sees, on the Agents page, the agent, the Flow and exactly what it would send (stored encrypted). **Confirm** runs it as the agent would have, on the same approved version (if the Flow changed since, it is not run); **Reject** drops it. A call nobody decides within a day lapses. Only the person the agent acts for decides.
- **Drafting.** Whether it may use `get_flow_guide` and `save_as_flow`.
- **Expiry.** 1 to 365 days, 90 by default. After that the token stops working; its person can extend it.

Every call an agent makes is recorded with its outcome and run, and listed on the Agents page with the agent's last use. Admins can list every agent in the organization (whose behalf it acts on, what it may use, its calls) and revoke any of them; only its person changes what it may use. Revoking an agent also rejects its waiting calls.

**Automatic stop.** An agent that keeps calling tools outside its scopes (3 within 10 minutes by default), whose runs keep hitting blocked calls, or whose runs' AI spend jumps far above its usual hour is stopped by itself: `tools/list` still answers, but every `tools/call` gets `agent_stopped`. Its token is not revoked and its waiting calls stay waiting. Its person or an admin resumes it, with a reason, under **Automatic stops**; the Agents page shows a banner meanwhile. A Flow tool whose Flow was stopped answers `flow_stopped`. See [governance.md](governance.md#automatic-stops-when-a-control-fails).

## The gateway: app actions as tools

Besides Flows, an org admin can offer **single actions of approved modules** as tools, including modules imported from MCP servers. That makes Dittoly the one place your agents reach your apps and other MCP servers, with the same controls. On the Agents page, under **App actions offered to agents**, the admin picks:

- an approved module version;
- one of its actions;
- the team it is for. Only that team's members can give it to their agents, and that team's shared accounts apply.

The tool is called `app_<module>_<action>`.

- **Pinned.** Each tool is pinned to the module version and to the exact name, description, input and output schemas that were approved. If the stored record no longer matches, or the module version is no longer approved, the tool disappears from agents' lists. For a module imported from an MCP server, every call also checks that the server still offers the same tool, with the same title, description and schemas. A server that rewrites a tool's description to steer the AI reading it (a "rug pull") is caught the same way as a changed schema. Such a tool is **blocked** and admins are notified. Import the server again, approve the new version, and offer it again. The same description check now applies to Flow steps that use imported MCP tools (`mcp_tool_changed`).
- **As the person.** A call runs through the broker exactly like a Flow step: the module's declared hosts only, with the agent's person's own credentials (or the team's shared account where the team set one). The organization's run rules apply: allowed hours and runs per day.
- **Writes ask first** when the agent was given the tool with *ask me first*. A call confirmed later runs only if the tool is still pinned to what the agent was shown.
- Each call is recorded on the agent and audited (`gateway.tool_called`); offering, removing and blocking are audited too.

Agents only get these tools when their person picks them. Tokens made before agents existed do not get them.

Tokens made before agents existed keep the access they had (every offered Flow, and drafting) until their person restricts them; the Agents page marks them *made before agent scopes*.

## Protocol details

- Transport: Streamable HTTP, `POST /mcp`, JSON responses, no sessions. `GET` (server-sent event streams) is not offered.
- Protocol versions 2025-11-25, 2025-06-18 and 2025-03-26, with the `initialize` handshake. Clients on the stateless 2026-07-28 revision that try `server/discover` get "method not found", the answer of a server on an earlier version, and fall back to `initialize`.
- Requests from a browser on another site are refused (the `Origin` check that guards against DNS rebinding).
- Sign-in is by personal token or by OAuth sign-in (below). Without a valid token `/mcp` answers `401` with `WWW-Authenticate: Bearer resource_metadata="<public URL>/.well-known/oauth-protected-resource/mcp"`, which is how apps find out where to sign in.

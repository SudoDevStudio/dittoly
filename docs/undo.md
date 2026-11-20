# Undo: reversing what a run or an AI agent changed

A Flow run or an AI agent sometimes changes the wrong thing: an announcement posted a day early, issues created in the wrong project. Dittoly can reverse such changes, but only when the module says exactly how, only within the organization's undo window, and only after an approver signs off.

## How a module declares it

A write action can name the action of the same module that reverses it. The input of that action is built from what the write sent (`{{ input.x }}`) and what it got back (`{{ output.y }}`):

```json
{
  "name": "post_message",
  "effect": "write",
  "undo": { "action": "delete_message", "input": { "channel": "{{ input.channel }}", "ts": "{{ output.ts }}" } }
}
```

Dittoly checks the declaration:

- `undo` is only allowed on write actions.
- The named action must be another write action of the same module.
- The input may only fill that action's inputs.
- Templates may only use `input` and `output`.

The admin sees it when reviewing the module: "It can be undone with delete_message (channel = {{ input.channel }}, ts = {{ output.ts }})", or "It cannot be undone by Dittoly". When the AI drafts or revises a module, it proposes an undo for each write action the app can really take back, and the reversing action that goes with it. It leaves undo out for things that cannot be taken back, such as an email sent, a merge or a payment. The bundled Slack module reverses `post_message` with `delete_message` (Slack's `chat.delete`).

Modules imported from MCP servers declare no undo.

## What is kept

When a write with a declared undo succeeds, Dittoly builds the reversing input straight away. It keeps only that input, encrypted, never the whole output. This happens in a Flow step (each `forEach` item separately, including in Flows a Super Flow runs) and in an AI agent's call to an app action through the [gateway](mcp-server.md#the-gateway-app-actions-as-tools).

That input is kept for the **undo window**: 7 days by default. Admins can set 1 to 90 days on the Members & Access page. It is separate from how long run inputs and outputs are kept. After the window, the input is dropped and the change shows as *No longer reversible*.

## Reversing

1. **Ask.** The person the run ran as, or the agent's person, opens the run (or the agent's calls on the Agents page). They choose what to reverse, by default every change that can still be reversed, and give a reason. An admin can ask too.
2. **Sign off.** Approvers see the request in their inbox ("Reverse 2 changes of Announce"), with the reason and the exact changes. On a shared server nobody signs off their own request. Rejecting reverses nothing.
3. **Reverse.** Each change is reversed **newest first**, through the broker like any step. It runs as the person who made the change, with their own access (or the team's shared account, where the team set one). One failure does not stop the others. The request then shows *Reversed* or *Partly reversed*, and each change shows whether it was reversed and why not. The person who asked is notified.

Requests, sign-offs, rejections and each reversed change are audit events: `reversal.requested`, `reversal.approved`, `reversal.rejected` and `undo.reversed`.

## Limits

- A change can only be reversed if its module declared how. Changes not listed on a run cannot be reversed by Dittoly.
- Reversing is not a time machine. If someone changed the item since, the reversing action acts on it as it is now. A reversal that fails, for example because the message was already deleted, shows its error.
- Dry runs change nothing, so they have nothing to reverse.

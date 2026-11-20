# Phone, glasses and chat apps

Give Dittoly commands from your phone, or from Meta glasses paired to it, without installing an app:

- "Run release notes for 2.4"
- "How did the release go?"
- "What's waiting for me?"
- "Approve it"

## Connecting a phone

1. In Dittoly on your computer, open **My credentials → Phone, glasses & chat apps** and choose **Connect a phone**.
2. Scan the QR code with the phone's camera. The page that opens is the phone's command page (`/m`).
   - The code works **once**, for **2 minutes**.
   - It sits in the link's `#` part, so it never reaches server logs, and the page removes it from the address bar.
3. The phone is now connected for **30 days**. It is listed under *Phone, glasses & chat apps*, where you (or an admin) can **Disconnect** it at any time.

**The phone must be able to open Dittoly's address.**
- `127.0.0.1` or `localhost` only works on the computer itself. Start Dittoly with `npm start -- --host=0.0.0.0` (or `HOST=0.0.0.0` in `.env`): the QR code then uses the computer's network address, even if the portal is open on localhost. Or use a tunnel. The phone must be on the same network. The pairing screen warns when the code cannot work.
- **Voice needs https.** Browsers only let a page use the microphone on https (or localhost). On a plain-http address the phone page still works, but you type, or use the keyboard's dictation.

## What a phone can do

A phone's session is separate from your browser session and limited to commands. It cannot:
- see credentials;
- change Flows or modules;
- connect more phones;
- open the rest of the portal.

| Command | What happens |
|---|---|
| Run a Flow | Starts any approved Flow you can run, with your own access. Missing inputs are asked for. |
| Run status | Says how a run is going, or why it is waiting or paused. Runs started from the phone are followed: it says when they finish or need you. |
| What's waiting | Reads out your sign-offs, forms to fill in, and teammate requests. |
| Answer a form | Fills in a run's input step. |
| Approve or reject | Signs off an approval step, or answers a teammate's delegation request. The usual rules apply: on a shared server, nobody approves their own run. |

**Anything that changes something waits for your yes.** The phone says exactly what it will do ("Run Release notes with release 2.4. Say yes to go ahead, or no.") and you answer by voice or tap.
- A proposal is only valid on the same phone.
- It expires after 2 minutes.
- It counts once.
- Saying something else cancels it.

## How commands are understood

The organization's AI (the one an admin configured) reads what you said, along with the lists of things you may act on right now:
- the Flows you can run;
- your recent runs;
- the sign-offs, forms and requests waiting for you.

It proposes one action. The server then:
- checks that every id is in those lists;
- checks the inputs against the Flow;
- asks for anything missing instead of guessing.

The transcript is passed to the AI as data. Without an AI configured, the phone page answers that no AI provider is set up.

## Meta glasses

Pair the glasses with your phone as usual. While they are the phone's headset:
- you speak into the **glasses' microphone** after tapping the microphone button on the phone page;
- replies are read aloud through the **glasses' speakers**;
- the **Speak** switch on the phone page turns spoken replies off.

This uses the glasses as a Bluetooth headset, which works with any Meta glasses and needs no Meta developer access.

Meta's own developer toolkit, the Wearables Device Access Toolkit, is not used. As of mid-2026 it was in developer preview:
- native apps could use the camera;
- Ray-Ban Display glasses could run web apps.

As far as we know, "Hey Meta" cannot start third-party commands. Speech recognition in the browser is still partly supported (Chrome on Android, Safari on iOS 14.5+); where it is missing, the phone page offers the text box.

## Ray-Ban Display

On a small, roughly square screen (for example the 600×600 display of Meta Ray-Ban Display glasses), or with `?display=glasses` in the address, the phone page switches to a heads-up layout:
- black background (black is see-through on these displays) and large, bright text;
- only the latest reply, and **Yes / No** when something waits for your yes; nothing scrolls;
- the buttons are reached with the arrow keys and pressed with Enter, which is how the glasses' controls reach web pages;
- **What's waiting** and **Last run** work without the AI.

Speak and type on the phone; the glasses show the answer and take the yes. What we built on is Meta's description of its Web Apps developer preview (May 2026: HTML/CSS/JS loaded by URL, a 600×600 display, arrow-key style navigation, no microphone for web apps), read from secondary sources because Meta's developer pages could not be opened from the build environment. **It has not been tried on real glasses**; how a web app on the glasses is opened and signed in may differ.

## Telegram and WhatsApp

The same commands work in a private chat with the organization's bot, with the same rules: the organization's AI proposes one action, and anything that changes something waits for **Yes** (a button, or typing yes).

1. On **My credentials → Phone, glasses & chat apps**, choose **Connect Telegram** or **Connect WhatsApp**.
2. Open the link it shows:
   - **Telegram:** `t.me/<bot>?start=<code>`, then press *Start*.
   - **WhatsApp:** a `wa.me` link that opens a chat with the business number and the message `link <code>`; send it.
3. The code works once, for 10 minutes. The chat is now linked to you for 30 days, listed with your devices, and can be disconnected there, or by sending `unlink`.

Runs started from the chat are followed: the chat is told when they finish, or when they wait for a sign-off, a form or a teammate. Group chats are refused. Each chat is linked to one person; linking it again replaces the earlier link.

**Setting it up (admins):**
- **Telegram:** create a bot with @BotFather and set `DITTOLY_TELEGRAM_BOT_TOKEN`. The server reads messages by long polling, so it needs no public address, but only **one** server may poll a bot, and the bot must have no webhook set.
- **WhatsApp** (WhatsApp Business Cloud API): set `DITTOLY_WHATSAPP_TOKEN` (an access token), `DITTOLY_WHATSAPP_PHONE_NUMBER_ID`, `DITTOLY_WHATSAPP_NUMBER` (the business number, digits only, for the `wa.me` link), `DITTOLY_WHATSAPP_APP_SECRET` and `DITTOLY_WHATSAPP_VERIFY_TOKEN` (any long random string), and optionally `DITTOLY_WHATSAPP_API_VERSION` (default `v26.0`). In the Meta app, set the webhook to `https://<your server>/channels/whatsapp` with that verify token and subscribe to `messages`. Deliveries are accepted only with a valid `X-Hub-Signature-256` for the app secret.
- These were built from the Telegram Bot API reference (version 10.3) and secondary descriptions of the WhatsApp Cloud API; **neither has been tried with a real bot or number yet.**

What goes where: the text of your messages goes to the chat provider (Telegram or Meta) and, to understand it, to the organization's AI. Dittoly sends replies as short sentences, never run data.

## Security notes

- Pairing codes and device tokens are random. Only their SHA-256 hashes are stored.
- Device sessions are httpOnly cookies and, like browser sessions, need the CSRF header for writes.
- Pending actions are stored encrypted and are covered by master-key rotation.
- Commands are rate-limited to 30 a minute per phone.
- Pairing, revoking and every confirmed action are recorded in the audit log.

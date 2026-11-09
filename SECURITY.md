# Security and data

Hermes Chrome lets an AI agent control your real browser, with your logins. Read this before you install it.

## What the agent can do

Once paired, your Hermes agent can open tabs, read pages, click, type and take screenshots **in the tabs of its own tab group**. It does not see or touch your other tabs unless you share one from the side panel (**Use this tab**). Anything you can do on a site where you are logged in, the agent can do too.

Guard rails you control (extension **Settings**):

- **Blocked sites**: hosts the agent refuses to open or act on (put your bank, email admin, cloud consoles here). No snapshots are taken on them either.
- **Ask me before risky clicks** (on by default): pay, buy, delete, send, publish, post and similar need your Allow.
- **Approvals happen outside the page.** Every Allow / Deny / Always allow decision is made in a small Hermes Chrome window, never in the web page, so a page cannot hide, restyle or fake the buttons. Buttons arm after a short pause; closing the window or not answering within two minutes counts as no.
- **Ask me first on these sites** (starts with webmail, payments, banks and brokers): every click, keystroke and submit needs your OK; no snapshots are taken there and JavaScript is never run there.
- **New sites**: the first action on a site you have not approved asks Decline / Allow once / Always allow.
- **Action check** (on by default, Hermes plugin only): before a risky click, a submit, or moving to another site from a page, your agent's own model compares the action with your latest message and shows you any mismatch. It is a second line of defence, not a guarantee: it uses the latest message from any of your chats, and if the model is unavailable it steps aside and the approvals above still apply.
- **Before every click** the tab must still be on the page that was approved and the point must still be over the named element; clicks into a frame are judged by the frame's own site.
- Only web pages: `file://`, `chrome://`, `javascript:`, `data:` and similar addresses are refused, certificate warnings stop the agent, and a redirect onto a blocked site is left at once.
- **Run JavaScript in pages** (off by default).
- **Stop agent** (right-click the toolbar icon) disconnects immediately; clicking or typing in the agent's tab pauses it.
- The agent never solves CAPTCHAs; it hands them to you.

## Where data lives

| Data | Where | Leaves your machine? |
|---|---|---|
| Pairing: device id and key | Extension storage (`chrome.storage.local`) | Only to your own Hermes when connecting |
| Device key on the Hermes side | Plugin state, **SHA-256 hash only** | No |
| Side-panel chat transcript | Extension storage, last 200 messages; **New chat** clears it | Messages go to your Hermes, which sends them to the model provider you configured |
| Activity snapshots (small JPEGs of each step) | Extension storage, last 60 steps; **Clear timeline** removes them | Only the end-of-task report: up to 3 snapshots to the Telegram chat you talk to the agent in |
| Files you attach in the side panel | Saved on the Hermes machine (plugin data folder) | To the model provider if the agent reads them |
| Recorded workflows (Teach) | On the Hermes machine as skills (`skills/browser-recordings/`) | No |
| Page content the agent reads | Not stored by this project | Sent to your model provider as part of the conversation, like any other tool output |

What a recording never contains: passwords, card numbers, CVV, IBAN, SSN, account numbers or one-time codes. Those fields are detected (input type, autocomplete hints, field names and labels) and stored as blanks; on replay the agent clicks into the field and asks you to type it. Detection is best effort: check the steps in the review screen before saving, and use **Ask for this each time** for anything personal.

## Network

- The extension connects **out** to your Hermes plugin (`ws://<host>:8798/ext`). Nothing listens on your laptop.
- Use it on the same machine, over Tailscale, or behind an HTTPS tunnel. The plugin listens on the LAN only if you set `allow_lan: true`: on a shared network plain `ws://` would let others read the device key. **Do not expose port 8798 to the internet.** That connection is not TLS-encrypted, so it relies on the private network.
- To reach Hermes over the internet, put it behind an HTTPS tunnel and set `public_url`: the extension then connects with `wss://` (TLS), the plugin listens on loopback only, and its internal endpoints refuse requests that carry proxy headers, so only the extension endpoint `/ext` is reachable. A paired device key is still required for everything.
- Credentials never go in URLs: the pairing code and device key are sent inside the WebSocket after it opens.
- Pairing codes are single use, expire after 5 minutes, and five wrong attempts cancel all open codes. On Telegram the message with the code deletes itself after 5 minutes.
- The plugin's internal RPC and the bridge's `/mcp` endpoint accept loopback (same machine) callers only. Both refuse requests from web pages (an `Origin` header) and the bridge refuses foreign `Host` headers (DNS rebinding). The bridge mints pairing codes only for callers holding its local secret file.
- With a tunnel, route only the path `/ext` to the plugin (see the Cloudflare example in the README).
- Pairing with a server that is not on this computer shows who will control the browser and warns when the address is neither encrypted nor private.
- Releases list the SHA-256 of the extension zip; compare it with `shasum -a 256 hermes-chrome-extension.zip` before loading it.
- Side-panel chat uses your Hermes API server on the same machine; its key is read on the server and never sent to the browser.

## No telemetry

This project sends no analytics, crash reports or usage data anywhere. The only network traffic is between your browser and your own Hermes, and whatever your Hermes already does (model provider, Telegram).

## Revoking access

- `/chrome devices` lists paired browsers; `/chrome revoke <name>` (or `all`) cuts one off immediately.
- **Unpair this browser** in the extension Settings forgets the key on that side.
- Disabling the plugin (`hermes plugins disable hermes-chrome`) closes everything.

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private reporting: **Security** tab → **Report a vulnerability** on this repository. Include steps to reproduce and the versions of the extension, plugin and Hermes.

# Hermes Chrome

Let your [Hermes Agent](https://hermes-agent.nousresearch.com) use your real Chrome, from any channel you talk to it on (Telegram, Discord, cron jobs, the CLI) or from a chat in Chrome's side panel.

You watch it work: an agent cursor glides to each target, clicks ripple, the page glows while it is busy, and it works in one tab inside its own tab group (`⏳ Hermes` while working, `✅ Hermes` when idle, `✋ Hermes` when it needs you). When it hits a CAPTCHA, a login or 2FA, it stops and shows a "needs you" banner; you finish the step and press Done.

```
 Telegram / CLI / cron / side panel
                 │
   Hermes Agent + hermes-chrome plugin  ◀──── WebSocket (paired device) ────  Chrome extension
   (laptop, home server or VPS)              same machine, LAN or Tailscale      (your laptop)
```

Setup is two steps: enable the plugin, then send `/chrome pair` and paste the code into the extension. No tokens, no config files.

**Easiest install:** send this to your Hermes agent and it does the rest, then tells you the three clicks left for Chrome:

```
Install Hermes Chrome for me: read https://raw.githubusercontent.com/whoisdhana/hermes-chrome/main/AGENT_INSTALL.md and follow it.
```

**Updating:** `hermes plugins update hermes-chrome` on the Hermes machine, then reload the extension from the updated `extension/` folder. The extension shows an **↑** badge and a banner when it and the plugin are out of step; it never updates anything itself. See [Updating](#updating).

The extension connects out to Hermes, so your laptop needs no open ports. When the laptop is asleep or Chrome is closed, the tools return one plain message (default `Browser not available`) and the agent tells you instead of guessing.

## Watching it work

- **Plan strip**: for multi-step tasks a slim bar at the top of the page shows the plan, the current step and progress (`Delulu · Exporting the CSV · 3/5`), with pause and stop. The tab group title follows along (`⏳ Delulu 3/5`).
- **A reason for every action**: every click, keystroke and key press must carry a short reason ("Opening the date picker"). It appears on approval prompts, in the side panel and in Activity; actions without one are refused.
- **Takeover**: touch the mouse or keyboard in the agent's tab and it pauses on its own ("You took over… Press ▶ when it can continue"). Pause and resume also from the strip, the side panel, or **⌥⇧.** (Alt+Shift+.).
- **Tab marker**: the agent's tab is marked next to the address bar (a badge on the toolbar icon: ● working, II paused, ! needs you) and in the tab strip (a coloured dot on the tab's icon).
- **Needs you**: CAPTCHAs, logins, payments and risky clicks raise a desktop notification and a "needs you" banner in the tab.
- **Activity**: the side panel's Activity tab lists every step with a snapshot. At the end of a task the agent tells you a short summary in the chat you talk to it in.

## Teach mode: record a task once, replay it any time

1. Open the page where the task starts. In the side panel's **Teach** tab press **⏺ Start recording**, then do the task as usual.
2. Press **⏹ Stop**, name it (`meta-ads-weekly-export`), remove stray steps, and tick **Ask for this each time** on any typed value that changes between runs.
3. **Save as skill**. With the plugin it becomes a Hermes skill (`skills/browser-recordings/<name>/`), so the agent can run it from any channel ("run meta-ads-weekly-export") or from a scheduled job.

Replay drives the same cursor and plan strip. Each element is found again by id, test id, name, label, role and text, so small page changes do not break it; if a step cannot be found the agent continues from there on its own. Passwords are never recorded: on replay the agent clicks into the field and hands it to you.

## Side-panel chat

Click the toolbar icon to open it. Right-click the icon for **Settings** and **Stop agent**.

- Replies stream in. While the agent works, one live status line shows the current step ("Delulu · Clicked Continue…"); turn on **Show each step in chat** in Settings to list every action instead. All steps are always in the Activity tab.
- **@-mention a tab**: type `@` and pick any of your open tabs to send its text along as read-only context ("compare @[Flipkart] with @[Amazon]"). The tab stays where it is, and the agent treats its content as data, not instructions.
- **Use this tab** hands the page you are on to the agent, so "fill this form" just works.
- **Model picker** in the header: any model from the providers you are signed in to in Hermes.
- **Attachments**: 📎 files, 📸 a screenshot of the tab, or paste and drop images. Images go to the model directly; other files are saved on the Hermes machine and the agent reads them with its file tools.
- **Slash commands**: type `/` for `/new`, `/model sonnet`, `/models`, `/stop`, `/screenshot`, `/tab off`, `/clear`, `/help`, and every skill of your agent (`/deep-dive …`).
- **Stop** cancels the turn and blocks browser actions for 20 seconds.

Chat uses the Hermes API server of the same profile. Turn it on with `API_SERVER_ENABLED=true` and an `API_SERVER_KEY` for that profile (Hermes keeps it with the profile's other secrets), and restart the gateway. The plugin gets the key only through Hermes' secret route (`agent.secret_scope.get_secret`), never by reading `.env` or any other file, and talks to `API_SERVER_HOST:API_SERVER_PORT` (default `127.0.0.1:8642`). The key stays on the server. If Hermes cannot hand the key to the plugin (for example a multi-profile gateway without a secret scope for this thread), the panel says side-panel chat is unavailable; browser control from your other chats keeps working.

## Why not the built-in options?

- **Hermes `browser` tool (cloud / headless)**: runs on a server with no history, so CAPTCHAs block it and you are logged in nowhere.
- **`browser.cdp_url` to a debug Chrome**: works, but needs a separate profile started with `--remote-debugging-port` and a tunnel.
- **Hermes native extension control** (`browser.extension_control`): serves sessions started from the API server or Desktop, not messaging channels like Telegram.

## Tools

| Tool | What it does |
|---|---|
| `chrome_status` | Connected? Lists agent tabs. Called first. |
| `chrome_tabs`, `chrome_open`, `chrome_close` | Tabs inside the agent tab group |
| `chrome_navigate` | Go to a URL, or `back` / `forward` |
| `chrome_read_page`, `chrome_find`, `chrome_text` | Page outline with element refs (`e12`), search, visible text |
| `chrome_screenshot` | The visible tab, saved in the plugin's data folder; returns the path (`MEDIA:<path>`) for the agent's vision tool or to send on |
| `chrome_click`, `chrome_type`, `chrome_key`, `chrome_scroll` | Real (trusted) input through the Chrome debugger API, with cursor animation |
| `chrome_batch` | Up to 20 steps in one call (fill a form and submit), each with the same checks as a single call; stops at the first error or when the page changes |
| `chrome_wait` | Pause up to 15 s |
| `chrome_handoff` | Ask you to do a step (CAPTCHA, login, payment) and wait for Done |
| `chrome_eval` | Run JavaScript in the page; off unless you enable it |
| `chrome_plan`, `chrome_report` | Plan strip and end of task (closes extra tabs, returns step counts) |
| `chrome_replay` | Run a recorded workflow, with variables |
| `chrome_extract` | Structured data from a page, or one record per list item (`multiple: true`). Your own model fills the fields; every value keeps its source URL, capture time, logged-in guess and the exact quote, and values whose quote is not on the page are dropped. Records collect in a named dataset |
| `chrome_export` | Write a dataset to Markdown (default: table plus a Sources section), CSV (formula-safe) or JSON in the plugin's data folder, and return the path |

The plugin also adds a one-line note to each turn while a browser is connected, so the agent reaches for these tools (they sit behind Hermes' tool search), and a bundled `browser` skill.

## Human pace

On by default. The real pointer travels along the same curve as the visible cursor (actual `mouseMoved` events, so hover menus and tooltips behave), clicks land at a slightly varied spot inside the element after a short pause, text is typed one key at a time at 60 to 180 ms per key, and the agent pauses briefly after each page load. Turn it off in Settings for speed. It does not get past CAPTCHAs; those go to you.

## Safety

Read [SECURITY.md](SECURITY.md) for exactly what data is stored where and what leaves your machine.

- The agent only acts on tabs in its own group, never on your other tabs.
- **One tab by default**: it reuses its own tab for each new page and opens extra tabs only for side-by-side work (research, comparing prices). Extra tabs close when the task ends, unless you turn on **Keep extra tabs open**. A tab you shared with it is never navigated away or closed.
- **Web pages only**: `file://`, `chrome://`, `javascript:`, `data:` and similar addresses are refused, and it stops at certificate (TLS) warnings instead of clicking through.
- **Blocked sites**: hosts the agent refuses to open or touch. Starts with password-manager vaults (1Password, Bitwarden, LastPass…).
- **Action check**: before a risky click, a form submit, or carrying data to another site in a link, the plugin asks your agent's own model whether it fits your latest request. If it does not, you see the reason and decide (Allow anyway / Deny). Pages that try to talk the agent into something else get caught here. Turn it off in Settings.
- **New sites**: the agent can read any page that is not blocked, but its first click or keystroke on a site you have not approved asks **Decline / Allow once / Always allow**. Allow once lasts until the task ends; always-allowed sites are listed (and removable) in Settings.
- **Ask me first**: on these hosts every click, keystroke and form submit waits for your OK. Starts with webmail, payment apps, banks and brokers. Both lists are editable in Settings.
- **Risky clicks** (pay, buy, delete, send, publish, post…) show an Allow / Deny banner first. Deny is the default focus.
- **Pairing**: codes are single use, expire after 5 minutes, and five wrong attempts cancel all open codes. The code comes back as the reply to `/chrome pair`, so it stays in that chat's history; it is useless once used or expired. Each browser gets its own key; Hermes stores only its hash. `/chrome devices` lists them, `/chrome revoke <name>` cuts one off immediately. Nothing secret ever goes in a URL.
- Use Tailscale, a LAN, or an HTTPS tunnel with `public_url` (see Setup) between laptop and server; never expose the raw port to the internet.
- The agent never solves CAPTCHAs; it hands them to you.
- **Stop agent** (right-click the toolbar icon) disconnects immediately.

Chrome shows a "started debugging this browser" bar while the agent has a tab attached. That is expected: it is how real clicks and keystrokes are sent.

## Setup

### 1. Plugin (on the machine running Hermes)

```bash
hermes plugins install hermes-chrome --enable          # from the Hermes plugin catalog, at the commit it pins
# or straight from this repository: hermes plugins install whoisdhana/hermes-chrome --enable
```

Needs Hermes 0.21.3 or newer.

Restart the gateway. The plugin listens on port 8798 on loopback and, if present, the machine's Tailscale address (the LAN only with `allow_lan: true`).

Optional settings in `config.yaml`:

```yaml
plugins:
  entries:
    hermes-chrome:
      settings:
        agent_name: Delulu                  # tab group and plan strip name (default: Hermes)
        offline_message: MacBook not available
        port: 8798                          # one port per profile if several use the plugin
        advertise_host: 100.x.y.z           # override the address put into pairing codes
        allow_lan: false                    # true: also listen on the LAN address (plain ws://, trusted networks only)
```

### 2. Extension (on your laptop)

1. Take the `extension/` folder of the plugin Hermes installed (`~/.hermes/plugins/hermes-chrome/extension`, or `<profile home>/plugins/hermes-chrome/extension` for a named profile). If the browser is on another computer, copy that folder over. Using the plugin's own copy keeps the extension at the same version as the plugin.
2. `chrome://extensions` (Brave: `brave://extensions`) → enable **Developer mode** → **Load unpacked** → pick that folder.
3. In Telegram pick `/chrome_pair` from the menu (any channel: `/chrome pair`; terminal: `hermes chrome pair`).
4. Right-click the extension icon → **Settings**, paste the code under **Pair**. The badge turns green.

If Hermes runs on the same computer, the short code alone works (`HC-7Q2K-9XPM`).

### Reach Hermes from anywhere (no Tailscale)

If Hermes runs on a server and you'd rather not set up Tailscale, put it behind an HTTPS tunnel and tell the plugin its public address:

```yaml
plugins:
  entries:
    hermes-chrome:
      settings:
        public_url: https://chrome.example.com   # pairing codes become HC-XXXX-XXXX@wss://chrome.example.com/ext
```

Restart the gateway. With `public_url` set the plugin listens on `127.0.0.1:8798` only; point the tunnel there with WebSockets on. Pairing works the same way, and TLS protects the device key on the way.

Cloudflare named tunnel (`~/.cloudflared/config.yml`), exposing only the extension endpoint:

```yaml
ingress:
  - hostname: chrome.example.com
    path: ^/ext$
    service: http://127.0.0.1:8798
  - service: http_status:404
```

Tailscale Funnel works too (`tailscale funnel --bg 8798`, then `public_url: https://<machine>.<tailnet>.ts.net`), and so does any reverse proxy that passes WebSockets (Caddy, nginx, ngrok with a fixed domain).

- Use a fixed hostname. Throwaway URLs (`trycloudflare.com`, free ngrok) change on restart and break the pairing.
- Only `/ext` answers requests that arrive through a tunnel; the plugin's internal endpoints refuse anything carrying proxy headers.
- Anyone can reach the URL, but nothing works without a paired device key, and five wrong pairing codes cancel all open codes.

### Other MCP agents (Claude Code, Cursor…)

`bridge/` is a standalone MCP server with the same extension protocol:

```bash
cd bridge && npm ci --omit=dev
HC_HOST=127.0.0.1,100.x.y.z npm start     # add your Tailscale/LAN address so the extension can reach it
npx hermes-chrome-bridge pair              # prints a pairing code
```

The bridge has no model of its own, so its `extract` returns the raw page text or list items (with refs, URL, time and logged-in guess) and the agent fills the fields; its `export` takes those records, checks every quote against the text `extract` returned, and writes the file to `HC_STATE_DIR/exports`.

Point your MCP client at `http://127.0.0.1:8798/mcp`. Variables: `HC_PORT`, `HC_AGENT_NAME`, `HC_UNAVAILABLE_MESSAGE`, `HC_STATE_DIR`, `HC_MCP_TOKEN`, `HC_MCP_ALLOW_REMOTE`, and `HC_HERMES_URL` / `HC_HERMES_KEY` for side-panel chat against a Hermes API server. A systemd unit is in [`deploy/`](deploy/hermes-chrome-bridge.service).

## Updating

Hermes Chrome has no self-updater. Updates arrive only through Hermes:

1. **Plugin**: on the Hermes machine run `hermes plugins update hermes-chrome` (it moves to the commit the catalog pins), then restart the gateway.
2. **Extension**: replace the extension's folder with the updated `extension/` folder of the plugin (or, if Chrome loads it straight from the plugin folder on the same computer, nothing to copy) and press reload on Hermes Chrome in `chrome://extensions`. Pairing, settings and recordings stay.

When the two are out of step, the toolbar icon shows **↑** and the side panel and Settings say which side is older. That notice is information only: it offers no download and no update button.

## What this plugin does on your machine

Read this before installing. [SECURITY.md](SECURITY.md) has the details.

- **Listens on the network.** The gateway that loads the plugin opens an HTTP + WebSocket listener on port 8798 (one port per profile) on `127.0.0.1`, and also on the machine's Tailscale address when Tailscale is up, or the LAN address with `allow_lan: true`. `/ext` is the extension's socket, `/rpc` lets other Hermes processes of the same profile reach it (loopback only, guarded by a per-profile secret in plugin state), `/health` answers `{"ok": true}` to anyone who can reach the listener (not through a tunnel).
- **Pairing with tokens.** A browser joins only with a single-use, 5-minute pairing code from `/chrome pair`; it then gets its own device key, of which the plugin stores only a SHA-256 hash. Five wrong codes pause pairing. `/chrome revoke` cuts a browser off.
- **Exposure is your choice.** Without settings the listener is reachable from this machine and your tailnet. `allow_lan: true` exposes plain `ws://` to the local network. `public_url` is for an HTTPS tunnel you run yourself (Cloudflare Tunnel, Tailscale Funnel, a reverse proxy); the plugin then listens on loopback only, and requests carrying proxy headers reach nothing but `/ext`. Never forward the raw port to the internet.
- **Runs one shell command.** At startup it runs `tailscale ip -4` (3-second timeout) to find the Tailscale address. Nothing else is executed; there is no `hermes plugins update` or restart triggered from the browser.
- **Calls your model.** The action check sends the proposed action, its stated reason, the page URL and your latest message to your own configured model through Hermes (`ctx.llm`), before risky clicks and submits (turn off in the extension's Settings). `chrome_extract` sends page text to the same model. Both use your provider and your quota.
- **No Telegram or other third-party calls.** The plugin itself only talks to your browser, to this profile's own Hermes API server at `API_SERVER_HOST:API_SERVER_PORT` (default `127.0.0.1:8642`, side-panel chat), and to your model through Hermes. What the agent does with tool results (sending them to your chat platform) is ordinary Hermes behaviour.
- **Secrets only through Hermes.** It reads `API_SERVER_KEY` (plus `API_SERVER_HOST` / `API_SERVER_PORT`) only with Hermes' `get_secret`; it never opens `.env`, `auth.json` or other credential files. It reads the profile's `config.yaml` (only its own `plugins` entry) and lists the profile's `skills/` folder for the side panel's `/` menu.
- **Runs JavaScript only if you allow it.** `chrome_eval` is off until you enable **Run JavaScript in pages** in the extension's Settings, and never runs on "Ask me first" sites.
- **Writes files on the Hermes machine.** Screenshots (last 50), side-panel attachments (kept 7 days), extraction datasets and exports in the plugin's data folder (`<profile home>/plugin-data/hermes-chrome/`), and recorded workflows as skills in `<profile home>/skills/browser-recordings/`.
- **Long-running background work.** The listener runs on a background thread for the life of the Hermes process.
- **No telemetry.** No analytics, crash reports or usage data are sent anywhere.

## Development

```bash
python -m unittest discover -s tests                   # plugin (needs aiohttp)
cd bridge && npm ci && npm i --no-save playwright && npx playwright install chromium
node test/e2e.mjs                                       # extension in a throwaway Chromium, end to end
python3 scripts/make-icons.py <portrait.png>            # regenerate icons
```

## Limitations

- Content inside iframes is not read yet.
- Coordinates assume 100% page zoom.
- The extension is not in the Chrome Web Store yet; load it unpacked.

## License

MIT

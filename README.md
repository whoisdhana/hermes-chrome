# Hermes Chrome

Let your [Hermes Agent](https://hermes-agent.nousresearch.com) use your real Chrome, from any channel you talk to it on (Telegram, Discord, cron jobs, the CLI) or from a chat in Chrome's side panel.

You watch it work: an agent cursor glides to each target, clicks ripple, the page glows while it is busy, and every tab it opens lives in its own tab group (`⏳ Hermes` while working, `✅ Hermes` when idle, `✋ Hermes` when it needs you). When it hits a CAPTCHA, a login or 2FA, it stops and shows a "needs you" banner; you finish the step and press Done.

```
 Telegram / CLI / cron / side panel
                 │
   Hermes Agent + hermes-chrome plugin  ◀──── WebSocket (paired device) ────  Chrome extension
   (laptop, home server or VPS)              same machine, LAN or Tailscale      (your laptop)
```

Setup is two steps: enable the plugin, then send `/chrome pair` and paste the code into the extension. No tokens, no config files.

The extension connects out to Hermes, so your laptop needs no open ports. When the laptop is asleep or Chrome is closed, the tools return one plain message (default `Browser not available`) and the agent tells you instead of guessing.

## Watching it work

- **Plan strip**: for multi-step tasks a slim bar at the top of the page shows the plan, the current step and progress (`Delulu · Exporting the CSV · 3/5`), with pause and stop. The tab group title follows along (`⏳ Delulu 3/5`).
- **Intent captions**: every action carries a short reason that appears next to the cursor ("Opening the date picker").
- **Takeover**: touch the mouse or keyboard in the agent's tab and it pauses on its own ("You took over… Press ▶ when it can continue"). Pause and resume also from the strip, the side panel, or **⌥⇧.** (Alt+Shift+.).
- **Needs you**: CAPTCHAs, logins, payments and risky clicks raise a Mac notification and, when you are talking to the agent on Telegram, a message there.
- **Activity**: the side panel's Activity tab lists every step with a snapshot. At the end of a task the agent sends a short report with the last snapshots to Telegram.

## Teach mode: record a task once, replay it any time

1. Open the page where the task starts. In the side panel's **Teach** tab press **⏺ Start recording**, then do the task as usual.
2. Press **⏹ Stop**, name it (`meta-ads-weekly-export`), remove stray steps, and tick **Ask for this each time** on any typed value that changes between runs.
3. **Save as skill**. With the plugin it becomes a Hermes skill (`skills/browser-recordings/<name>/`), so the agent can run it from any channel ("run meta-ads-weekly-export") or from a scheduled job.

Replay drives the same cursor and plan strip. Each element is found again by id, test id, name, label, role and text, so small page changes do not break it; if a step cannot be found the agent continues from there on its own. Passwords are never recorded: on replay the agent clicks into the field and hands it to you.

## Side-panel chat

Click the toolbar icon to open it. Right-click the icon for **Settings** and **Stop agent**.

- Replies stream in; every browser action shows as a chip ("🖱 Clicked Continue").
- **Use this tab** hands the page you are on to the agent, so "fill this form" just works.
- **Model picker** in the header: any model from the providers you are signed in to in Hermes.
- **Attachments**: 📎 files, 📸 a screenshot of the tab, or paste and drop images. Images go to the model directly; other files are saved on the Hermes machine and the agent reads them with its file tools.
- **Slash commands**: type `/` for `/new`, `/model sonnet`, `/models`, `/stop`, `/screenshot`, `/tab off`, `/clear`, `/help`, and every skill of your agent (`/deep-dive …`).
- **Stop** cancels the turn and blocks browser actions for 20 seconds.

Chat uses the Hermes API server of the same profile (`API_SERVER_ENABLED=true` and `API_SERVER_KEY` in its `.env`). The plugin reads the key itself; it stays on the server.

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
| `chrome_screenshot` | The visible tab, shown to the model as an image |
| `chrome_click`, `chrome_type`, `chrome_key`, `chrome_scroll` | Real (trusted) input through the Chrome debugger API, with cursor animation |
| `chrome_wait` | Pause up to 15 s |
| `chrome_handoff` | Ask you to do a step (CAPTCHA, login, payment) and wait for Done |
| `chrome_eval` | Run JavaScript in the page; off unless you enable it |
| `chrome_plan`, `chrome_report` | Plan strip and end-of-task report |
| `chrome_replay` | Run a recorded workflow, with variables |

The plugin also adds a one-line note to each turn while a browser is connected, so the agent reaches for these tools (they sit behind Hermes' tool search), and a bundled `browser` skill.

## Human pace

On by default. The real pointer travels along the same curve as the visible cursor (actual `mouseMoved` events, so hover menus and tooltips behave), clicks land at a slightly varied spot inside the element after a short pause, text is typed one key at a time at 60 to 180 ms per key, and the agent pauses briefly after each page load. Turn it off in Settings for speed. It does not get past CAPTCHAs; those go to you.

## Safety

Read [SECURITY.md](SECURITY.md) for exactly what data is stored where and what leaves your machine.

- The agent only acts on tabs in its own group, never on your other tabs.
- **Blocked sites**: hosts the agent refuses to open or touch (your bank, for example).
- **Risky clicks** (pay, buy, delete, send, publish, post…) show an Allow / Deny banner first. Deny is the default focus.
- **Pairing**: codes are single use, expire after 5 minutes (on Telegram the code message deletes itself then), and five wrong attempts cancel all open codes. Each browser gets its own key; Hermes stores only its hash. `/chrome devices` lists them, `/chrome revoke <name>` cuts one off immediately. Nothing secret ever goes in a URL.
- Use Tailscale or a LAN between laptop and server; do not expose the port to the internet.
- The agent never solves CAPTCHAs; it hands them to you.
- **Stop agent** (right-click the toolbar icon) disconnects immediately.

Chrome shows a "started debugging this browser" bar while the agent has a tab attached. That is expected: it is how real clicks and keystrokes are sent.

## Setup

### 1. Plugin (on the machine running Hermes)

```bash
hermes plugins install whoisdhana/hermes-chrome --enable
# or: git clone https://github.com/whoisdhana/hermes-chrome ~/.hermes/plugins/hermes-chrome && hermes plugins enable hermes-chrome
```

Restart the gateway. The plugin listens on port 8798 on loopback and, if present, the machine's Tailscale address (else its LAN address).

Optional settings in `config.yaml`:

```yaml
plugins:
  entries:
    hermes-chrome:
      settings:
        agent_name: Delulu                  # cursor label and tab group name (default: Hermes)
        offline_message: MacBook not available
        port: 8798                          # one port per profile if several use the plugin
        advertise_host: 100.x.y.z           # override the address put into pairing codes
```

### 2. Extension (on your laptop)

1. Download `hermes-chrome-extension.zip` from [Releases](https://github.com/whoisdhana/hermes-chrome/releases/latest) and unzip it (or use the `extension/` folder of a clone).
2. `chrome://extensions` (Brave: `brave://extensions`) → enable **Developer mode** → **Load unpacked** → pick the unzipped folder.
3. In Telegram pick `/chrome_pair` from the menu (any channel: `/chrome pair`; terminal: `hermes chrome pair`).
4. Right-click the extension icon → **Settings**, paste the code under **Pair**. The badge turns green.

If Hermes runs on the same computer, the short code alone works (`HC-7Q2K-9XPM`).

### Other MCP agents (Claude Code, Cursor…)

`bridge/` is a standalone MCP server with the same extension protocol:

```bash
cd bridge && npm ci --omit=dev
HC_HOST=127.0.0.1,100.x.y.z npm start     # add your Tailscale/LAN address so the extension can reach it
npx hermes-chrome-bridge pair              # prints a pairing code
```

Point your MCP client at `http://127.0.0.1:8798/mcp`. Variables: `HC_PORT`, `HC_AGENT_NAME`, `HC_UNAVAILABLE_MESSAGE`, `HC_STATE_DIR`, `HC_MCP_TOKEN`, `HC_MCP_ALLOW_REMOTE`, and `HC_HERMES_URL` / `HC_HERMES_KEY` for side-panel chat against a Hermes API server. A systemd unit is in [`deploy/`](deploy/hermes-chrome-bridge.service).

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

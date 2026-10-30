# Spec: Hermes plugin + pairing (v0.3)

Goal: any Hermes user connects the extension with one install command and one pasted code. No bridge token, no Node, no service file, no MCP config, no TOOLS.md edits.

## User flow

1. `hermes plugins install whoisdhana/hermes-chrome --enable` (or clone the repo into `~/.hermes/plugins/hermes-chrome/`), restart the gateway.
2. Load the extension (unpacked for now).
3. In any channel: `/chrome pair` → Hermes replies `HC-7Q2K-9XPM@100.64.12.34:8798` (or `hermes chrome pair` in a terminal).
4. Paste into the extension's single **Pair** field. Done; the badge turns green.

Same-machine Hermes: the extension also tries `127.0.0.1:8798`, so the code alone (`HC-7Q2K-9XPM`) is enough.

## Pairing protocol

- `/chrome pair` creates a one-time code: 8 chars from an unambiguous alphabet, single use, expires in 10 minutes, max 5 failed attempts then invalid.
- The code string embeds the address the plugin detected: Tailscale IP if present, else primary LAN IP, else 127.0.0.1. Override with plugin setting `advertise_host`.
- Extension opens `ws://host:port/ext`, first frame `{type: "pair", code, deviceName}`. Plugin answers `{type: "paired", deviceId, deviceKey}` (32 random bytes) and stores only `sha256(deviceKey)`.
- Every later connection: first frame `{type: "hello", deviceId, deviceKey, ...}`. Unknown or revoked device → close 4001. Nothing secret ever goes in a URL.
- `/chrome devices` lists paired browsers (name, last seen); `/chrome revoke <name|id>` removes one and drops its live connection.
- One live browser per profile at a time; a newer authenticated connection replaces the old one (same as today).

## Plugin layout (Python, no new dependencies: aiohttp ships with Hermes)

```
(repo root = the plugin)
  plugin.yaml          name, version, provides_tools, provides_hooks
  __init__.py          register(ctx)
  server.py            aiohttp WS + loopback RPC on a daemon thread with its own event loop
  pairing.py           codes, device keys (ctx.state, profile-scoped)
  tools.py             the 16 tools, same names/semantics as the MCP bridge, prefixed chrome_
  chat.py              side-panel chat relay to the profile's own API server
  skill/SKILL.md       how to use the tools (refs, handoff, never solve CAPTCHAs)
```

- **Process model.** `register()` runs in every Hermes process (gateway, CLI, cron). The first one to bind the port owns the browser connection; other processes send tool calls to it over a loopback RPC endpoint authenticated with a random local secret in `ctx.state`. So `hermes chat` in a terminal can drive the browser the gateway holds.
- **Ports.** Setting `port` (default 8798). Several profiles with the plugin enabled each need their own port; the pair code carries it.
- **Binds** `127.0.0.1` plus the advertised address only. RPC endpoint is loopback-only.
- **Tool visibility.** Plugin tools sit behind tool search like MCP tools. A `pre_llm_call` hook adds one line per turn: when a browser is connected, "Browser connected (Delulu tab group). Use the chrome_* tools; load with tool_search 'chrome'." When none is connected and the user asks for browser work, the tools return the configured offline message (default `Browser not available`).
- **Side-panel chat.** The plugin reads the profile's own `API_SERVER_KEY` from its environment and relays to its API server, so users copy no keys. If the API server is disabled, the panel says how to enable it.
- **Settings** (`plugins.entries.hermes-chrome.settings`): `port`, `advertise_host`, `offline_message`, `agent_name` (sent to the extension so the cursor and group use the agent's name).

## Extension changes

- Settings page collapses to: **Pair** field (paste code) + Unpair. Bridge URL/token fields move under "Advanced" for the standalone MCP bridge.
- Agent name comes from the plugin on connect (still overridable).
- Stores `{host, port, deviceId, deviceKey}` in `chrome.storage.local`.

## Standalone MCP bridge

Kept in `bridge/` for non-Hermes agents (Claude Code, Cursor). It gains the same pairing (`hermes-chrome-bridge pair` prints a code) so both paths share one extension protocol.


## Out of scope for v0.3

Chrome Web Store listing, browser-provider (CDP relay) mode, hosted relay, Firefox.

## Tests

- Unit: code expiry, single use, attempt limit, device key hashing, revoke.
- E2E (existing harness): plugin server in a test process + extension in throwaway Chromium: pair → tools → reconnect with device key → revoke → 4001.
- Live: a real profile, Telegram `/chrome pair`, one browsing task, side-panel chat.

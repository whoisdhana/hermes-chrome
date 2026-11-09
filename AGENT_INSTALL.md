# Install Hermes Chrome (instructions for the Hermes agent)

You are a Hermes agent. Your user asked you to install Hermes Chrome so you can use their real Chrome. Do the steps below yourself with your terminal tool, then give the user the short checklist at the end. Keep your messages short and plain. Never print, paste or ask for API keys, tokens or the contents of `.env`.

If you run as a named profile (not the default one), put `-p <your profile>` right after `hermes` in every command below.

## 1. Install or update the plugin

```bash
hermes plugins list
```

- Not listed: `hermes plugins install whoisdhana/hermes-chrome --enable --yes-deps`
- Listed but disabled: `hermes plugins enable hermes-chrome`
- Already installed and enabled: `hermes plugins update hermes-chrome`

## 2. Settings

Use your own name, so the cursor and tab group carry it:

```bash
hermes config set plugins.entries.hermes-chrome.settings.agent_name "<your name>"
```

If another profile on this machine already uses Hermes Chrome, give this one its own port: `hermes config set plugins.entries.hermes-chrome.settings.port 8799` (8800, 8801… for more).

## 3. How will the user's Chrome reach this machine?

Work it out; ask only if you cannot tell.

- **Hermes runs on the user's own computer** (the one with Chrome): nothing to do.
- **Tailscale is set up here** (`tailscale ip -4` prints an address) and the user's laptop is on the same tailnet: nothing to do. The plugin uses that address by itself.
- **Same home or office network**: nothing to do. The plugin uses this machine's LAN address.
- **Anything else** (a VPS or cloud server, no Tailscale): it needs a public HTTPS address that forwards to `http://127.0.0.1:8798` (the port from step 2) with WebSockets on. Ask the user which they have:
  - A Cloudflare named tunnel or a domain behind Cloudflare: add an ingress rule for a hostname such as `chrome.example.com` with `path: ^/ext$` and `service: http://127.0.0.1:8798`.
  - Tailscale Funnel: `tailscale funnel --bg 8798`, the address is `https://<machine>.<tailnet>.ts.net`.
  - Caddy or nginx already serving a domain: proxy a hostname to `127.0.0.1:8798` with WebSocket upgrade.

  Then set it:

  ```bash
  hermes config set plugins.entries.hermes-chrome.settings.public_url https://chrome.example.com
  ```

  Do not use throwaway tunnels (`trycloudflare.com`, free ngrok): the address changes on restart and the user would have to pair again. Never open port 8798 itself to the internet.

## 4. Side-panel chat (optional)

The chat inside Chrome's side panel needs this profile's API server. Check without printing values:

```bash
grep -cE '^API_SERVER_(ENABLED|KEY)=' "$(hermes config env-path)"
```

`2` means it is on. Otherwise ask the user whether they want side-panel chat. Only if they say yes, add `API_SERVER_ENABLED=true` and `API_SERVER_KEY=<a new random 32-byte hex string>` to that `.env` file without showing the key in chat. Browser control from chat apps works without it.

## 5. Restart, then pair

The plugin loads when the gateway restarts, which ends your current reply. First send the user the checklist below, then restart in the background so your message gets out:

```bash
nohup sh -c 'sleep 15; hermes gateway restart' >/dev/null 2>&1 &
```

If that is not possible here, ask the user to send `/restart` instead.

### Checklist to send the user (fill in the bits in brackets)

> Hermes Chrome is installed. I'm restarting to load it; give me a minute.
>
> 1. Download the extension: https://github.com/whoisdhana/hermes-chrome/releases/latest/download/hermes-chrome-extension.zip and unzip it.
> 2. In Chrome open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked** and pick the unzipped folder.
> 3. Send me `/chrome pair` (on Telegram: `/chrome_pair`). Right-click the new Hermes Chrome icon → **Settings**, paste the code and click **Pair**. The icon turns green.
>
> Then just ask me to do things in your browser. I work in my own tab group, you'll see my cursor, and I'll hand over to you for logins and CAPTCHAs.

## If something goes wrong

- `hermes plugins doctor hermes-chrome` checks the plugin.
- `/chrome status` shows whether a browser is connected and the address codes point to.
- Pairing says "Could not reach…": the user's computer cannot reach the address in the code. Recheck step 3.
- Codes are single use and last 5 minutes; send `/chrome pair` again for a new one.

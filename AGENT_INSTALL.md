# Install or update Hermes Chrome (instructions for the Hermes agent)

You are a Hermes agent. Your user asked you to install or update Hermes Chrome so you can use their real Chrome. Do the steps below yourself with your terminal tool, then give the user the short checklist at the end. Keep your messages short and plain. Never print, paste or ask for API keys, tokens or the contents of `.env`.

If you run as a named profile (not the default one), put `-p <your profile>` right after `hermes` in every command below.

**Updating?** If Hermes Chrome is already installed and the user asked to update it: do step 1 (it updates the plugin), skip steps 2 to 4 (their settings stay), do step 5, and send the **update checklist** instead of the install checklist. Report the old and new version (`hermes plugins list` before and after).

## 1. Install or update the plugin

```bash
hermes plugins list
```

- Not listed: `hermes plugins install hermes-chrome --enable --yes-deps` (from the plugin catalog; needs Hermes 0.21.3 or newer)
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
- **Same home or office network, no Tailscale**: prefer Tailscale or the HTTPS option below. Only if the user insists on the plain LAN, set `hermes config set plugins.entries.hermes-chrome.settings.allow_lan true` and tell them anyone on that network could watch the connection.
- **Anything else** (a VPS or cloud server, no Tailscale): it needs a public HTTPS address that forwards to `http://127.0.0.1:8798` (the port from step 2) with WebSockets on. Ask the user which they have:
  - A Cloudflare named tunnel or a domain behind Cloudflare: add an ingress rule for a hostname such as `chrome.example.com` with `path: ^/ext$` and `service: http://127.0.0.1:8798`.
  - Tailscale Funnel: `tailscale funnel --bg 8798`, the address is `https://<machine>.<tailnet>.ts.net`.
  - Caddy or nginx already serving a domain: proxy a hostname to `127.0.0.1:8798` with WebSocket upgrade.

  Then set it:

  ```bash
  hermes config set plugins.entries.hermes-chrome.settings.public_url https://chrome.example.com
  ```

  Do not use throwaway tunnels (`trycloudflare.com`, free ngrok): the address changes on restart and the user would have to pair again. Never open port 8798 itself to the internet.

## 4. Side-panel chat (optional, ask first)

The chat inside Chrome's side panel needs this profile's API server. Check without printing values:

```bash
grep -cE '^API_SERVER_(ENABLED|KEY)=' "$(hermes config env-path)"
```

`2` means it is already on. Otherwise **do not turn it on yourself**: ask the user "Do you also want to chat with me from Chrome's side panel? (yes/no)" and wait. Only after an explicit yes, set both through Hermes, without showing the key in chat:

```bash
hermes config set API_SERVER_ENABLED true
hermes config set API_SERVER_KEY "$(openssl rand -hex 32)" >/dev/null
```

No answer or no: skip it. Browser control from chat apps works without it. The plugin gets the key from Hermes itself; it never reads `.env`.

## 5. Restart, then pair

Plugins load when a Hermes process starts, so the plugin is not active in this conversation yet. Check how you are running:

```bash
hermes gateway status
```

- **Gateway running** (Telegram, Discord and so on): send the user the checklist below first, then restart in the background so your message gets out. If that is not possible here, ask the user to send `/restart` instead.

  ```bash
  nohup sh -c 'sleep 15; hermes gateway restart' >/dev/null 2>&1 &
  ```

- **No gateway** (the user is talking to you in `hermes chat` in a terminal): tell the user to quit this chat (`/exit`) and run `hermes chat` again. `/new` is not enough. Then send the checklist.

### Checklist to send the user (fill in the bits in brackets)

> Hermes Chrome is installed. [Gateway: I'm restarting to load it, give me a minute. | Terminal chat: quit this chat with /exit and run `hermes chat` again to load it.]
>
> 1. The extension is the `extension` folder of the plugin I just installed: [the path from `hermes plugins list` / `<hermes home>/plugins/hermes-chrome/extension`]. [Only if I run on a different computer than your browser: copy that folder to your computer; I can send it to you as a zip.]
> 2. In Chrome open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked** and pick that folder.
> 3. Send me `/chrome pair` (on Telegram: `/chrome_pair`). Right-click the new Hermes Chrome icon → **Settings**, paste the code and click **Pair**. The icon turns green.
>
> Then just ask me to do things in your browser. I work in my own tab group, you'll see my cursor, and I'll hand over to you for logins and CAPTCHAs.

### Update checklist to send the user

> Hermes Chrome is updated from [old version] to [new version]. [Gateway: I'm restarting to load it, give me a minute. | Terminal chat: quit this chat with /exit and run `hermes chat` again.]
>
> Now update the extension from the updated plugin's `extension` folder: [same computer: nothing to copy if Chrome loads it from the plugin folder | other computer: replace your Hermes Chrome folder with the new `extension` folder, which I can send you as a zip]. Then press the reload icon on Hermes Chrome in `chrome://extensions`.
>
> Your pairing, settings and recordings stay. If Chrome asks to approve new permissions, accept them.

## If something goes wrong

- `cd / && hermes plugins doctor hermes-chrome` checks the installed plugin (run it from `/`: in a folder that contains a `hermes-chrome` directory, doctor checks that folder instead).
- `/chrome status` shows whether a browser is connected and the address codes point to.
- Pairing says "Could not reach…": the user's computer cannot reach the address in the code. Recheck step 3.
- Codes are single use and last 5 minutes; send `/chrome pair` again for a new one.
- The extension shows **↑** or "plugin is older": the extension and plugin are different versions. Update the side that is older as in the update checklist; the extension never updates itself.

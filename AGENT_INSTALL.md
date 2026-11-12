# Install or update Hermes Chrome (instructions for the Hermes agent)

You are a Hermes agent. Your user asked you to install or update Hermes Chrome so you can use their real Chrome. Do the steps below yourself with your terminal tool, then give the user the short checklist at the end. Keep your messages short and plain. Never print, paste or ask for API keys, tokens or the contents of `.env`.

If you run as a named profile (not the default one), put `-p <your profile>` right after `hermes` in every command below.

## Before you start

- **One browser profile pairs with one agent.** If the user already paired their browser with another agent, pairing it with you takes it away from that agent. Ask which browser you get: another Chrome profile, another browser (Brave, Edge), or a browser on another computer. Each agent can have several browsers; a browser has one agent.
- **You and the browser can be on different computers.** The browser only has to reach this machine (step 3).
- **Only you get the browser.** Other profiles on this machine stay without it unless the user asks each of them to install it too.

**Updating?** If Hermes Chrome is already installed and the user asked to update it: do step 1 (it updates the plugin), skip steps 2 to 4 (their settings stay), do step 5, and send the **update checklist** instead of the install checklist. Then do step 6 if the update helper is not installed yet. Report the old and new version (`hermes plugins list` before and after).

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

Leave the port alone. The default profile uses 8798 and every named profile gets its own port from its name (8800 to 8999), also when one gateway serves several profiles (needs Hermes Chrome 0.8.7 or newer). Set `plugins.entries.hermes-chrome.settings.port` only if `/chrome status` reports a port clash after the restart; the message names the port to use.

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

`2` means it is already on. Otherwise **do not turn it on yourself**: ask the user "Do you also want to chat with me from Chrome's side panel? (yes/no)" and wait. Only after an explicit yes, add `API_SERVER_ENABLED=true` and `API_SERVER_KEY=<a new random 32-byte hex string>` to that `.env` file without showing the key in chat. No answer or no: skip it. Browser control from chat apps works without it.

## 5. Restart, then pair

Plugins load when a Hermes process starts, so the plugin is not active in this conversation yet. Check how you are running:

```bash
hermes gateway status
```

- **Gateway running** (Telegram, Discord and so on): send the user the checklist below first, then restart in the background so your message gets out. If that is not possible here, ask the user to send `/restart` instead.

  If this gateway serves several profiles (`multiplex_profiles: true` in the main `config.yaml`), the restart interrupts every agent on it for a minute or two. Say so and wait for the user's yes before restarting.

  ```bash
  nohup sh -c 'sleep 15; hermes gateway restart' >/dev/null 2>&1 &
  ```

- **No gateway** (the user is talking to you in `hermes chat` in a terminal): tell the user to quit this chat (`/exit`) and run `hermes chat` again. `/new` is not enough. Then send the checklist.

### Checklist to send the user (fill in the bits in brackets)

> Hermes Chrome is installed. [Gateway: I'm restarting to load it, give me a minute. | Terminal chat: quit this chat with /exit and run `hermes chat` again to load it.]
>
> 1. Download the extension: https://github.com/whoisdhana/hermes-chrome/releases/latest/download/hermes-chrome-extension.zip and unzip it.
> 2. In Chrome open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked** and pick the unzipped folder.
> 3. Send me `/chrome pair` (on Telegram: `/chrome_pair`). Right-click the new Hermes Chrome icon → **Settings**, paste the code and click **Pair**. The icon turns green.
> 4. [Only if I run on a different computer than your browser:] Once, for one-click updates later: open Terminal on the computer with the browser and run
>    `curl -fsSL https://raw.githubusercontent.com/whoisdhana/hermes-chrome/main/updater/install.sh | bash`
>
> Then just ask me to do things in your browser. I work in my own tab group, you'll see my cursor, and I'll hand over to you for logins and CAPTCHAs.

### Update checklist to send the user

> Hermes Chrome is updated from [old version] to [new version]. [Gateway: I'm restarting to load it, give me a minute. | Terminal chat: quit this chat with /exit and run `hermes chat` again.]
>
> Now update the extension: open the Hermes Chrome side panel and press **Update now** in the update banner. It updates and reloads itself.
>
> If the banner shows a Terminal command instead of **Update now**, update by hand this time:
> 1. Download https://github.com/whoisdhana/hermes-chrome/releases/latest/download/hermes-chrome-extension.zip and unzip it **over your current Hermes Chrome folder** (the one you loaded in `chrome://extensions`), replacing the files.
> 2. Press **Reload extension** in the banner (or the reload icon on its card in `chrome://extensions`).
> 3. [Only if I run on a different computer than your browser:] For one-click updates next time, run the command from the banner once in Terminal on the computer with the browser.
>
> Your pairing, settings and recordings stay. If Chrome asks to approve new permissions, accept them.

## 6. One-click updates (update helper)

An unpacked extension cannot replace its own files, so **Update now** in the extension uses a small helper installed once on the computer that runs the browser (macOS or Linux). It only downloads the official release, checks its SHA-256 and replaces the extension's own folder.

- **Hermes runs on the same computer as the browser**: install it yourself, but only after the user has done **Load unpacked** (the installer finds the extension in the browser profiles). Check with `chrome_status` or ask the user, then run:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/whoisdhana/hermes-chrome/main/updater/install.sh | bash
  ```

  It prints the extension folder(s) and browsers it set up. "Hermes Chrome was not found" means the extension is not loaded yet: ask the user to finish the checklist and run it again. Tell the user in one line that **Update now** works from the next update on.
- **Hermes runs on another computer**: you cannot install it there. Item 4 of the install checklist (or item 3 of the update checklist) gives the user the command.

Running it again is safe (it refreshes the setup); `... | bash -s -- --uninstall` removes it.

## After the restart: check it took

- `hermes plugins list` shows `hermes-chrome` as enabled, with the version you expect.
- `hermes chrome status` (or `/chrome status` in chat) answers. Before pairing it says no browser is connected; that is correct.
- After the user pairs, it names their browser. Tell the user in one line that it worked, and which browser you are connected to.

## If something goes wrong

- A named profile does not list `hermes-chrome` although the main profile has it: plugins are per profile. Run the install command from step 1 with `-p <your profile>`.
- The side panel shows another agent's name or an old chat after pairing: update the extension to 0.8.7 or newer, then press the new-chat icon once.

- `cd / && hermes plugins doctor hermes-chrome` checks the installed plugin (run it from `/`: in a folder that contains a `hermes-chrome` directory, doctor checks that folder instead).
- `/chrome status` shows whether a browser is connected and the address codes point to.
- Pairing says "Could not reach…": the user's computer cannot reach the address in the code. Recheck step 3.
- Codes are single use and last 5 minutes; send `/chrome pair` again for a new one.
- **Update now** fails: the error is shown in the banner and logged in `~/.hermes-chrome-updater/updater.log` on the browser's computer. "not set up for this copy" means the extension was loaded from another folder since the helper was installed: run the installer again.

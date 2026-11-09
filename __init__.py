"""Hermes Chrome: let the agent use the user's real Chrome through the Hermes Chrome extension.

Setup for users: enable the plugin, run /chrome pair, paste the code into the extension.
"""
from __future__ import annotations

import time
from datetime import datetime
from pathlib import Path

import threading

from . import recordings, telegram_note
from .hub import CODE_TTL, EXTENSION_DOWNLOAD, PLUGIN_VERSION, Hub, version_tuple
from .tools import TOOLS, make_handler

HELP = """/chrome_pair      new pairing code for the Hermes Chrome extension (5 minutes, one use)
/chrome pair      same
/chrome status    is a browser connected?
/chrome devices   paired browsers
/chrome revoke <name or id | all>   unpair a browser"""


def register(ctx):
    profile = ctx.profile_name
    hub = Hub(
        ctx,
        port=int(ctx.get_config("port", default=8798)),
        advertise_host=ctx.get_config("advertise_host", default=None) or None,
        public_url=ctx.get_config("public_url", default=None) or None,
        offline_message=ctx.get_config("offline_message", default="Browser not available"),
        agent_name=ctx.get_config("agent_name", default=None) or ("Hermes" if profile in ("default", "custom") else profile.title()),
    )
    hub.start()

    for name, method, schema in TOOLS:
        ctx.register_tool(name=name, toolset="hermes_chrome", schema=schema, handler=make_handler(hub, name, method), emoji="🌐")

    cache = {"at": 0.0, "status": {}}
    told_update = set()  # (browser id, extension version) the agent was already told about

    def hint(**_):
        if time.time() - cache["at"] > 5:
            cache.update(at=time.time(), status=hub.status())
        st = cache["status"]
        if st.get("connected"):
            names = [b["name"] for b in st.get("browsers") or []]
            if len(names) > 1:
                device = (f"s are connected: {', '.join(chr(34) + n + chr(34) for n in names)} (default {st.get('device')!r}; "
                          "pass browser: <name> to pick one, and use the one the user names)")
            else:
                device = f' "{st["device"]}" is connected' if st.get("device") else " is connected"
            flows = recordings.names()
            stale = [b for b in st.get("browsers") or [] if version_tuple(b.get("extension")) and PLUGIN_VERSION
                     and version_tuple(b["extension"]) < version_tuple(PLUGIN_VERSION) and (b["id"], b["extension"]) not in told_update]
            told_update.update((b["id"], b["extension"]) for b in stale)
            update = (f" Tell the user once, briefly: their Hermes Chrome extension ({stale[0]['extension']}) is older than this "
                      f"plugin ({PLUGIN_VERSION}); download {EXTENSION_DOWNLOAD}, unzip it over the old extension folder and press "
                      "Reload in the extension's side panel (or in chrome://extensions).") if stale else ""
            return (f"[hermes-chrome] The user's own Chrome{device} (your tab group: {hub.agent_name}). For anything in a "
                    "web browser use the chrome_* tools (load them with tool_search query \"chrome\"), not the built-in browser "
                    "tools. For multi-step tasks: chrome_plan first, a short `why` on every action, chrome_report at the end. "
                    "Use chrome_handoff for CAPTCHA, login, 2FA or payment steps; never solve CAPTCHAs."
                    + (f" Recorded workflows (run with chrome_replay): {', '.join(flows[:20])}." if flows else "") + update)
        if st.get("devices"):
            return f"[hermes-chrome] The user's Chrome is not connected right now. If they ask for browser work, reply: {hub.offline_message}"
        return None

    ctx.register_hook("pre_llm_call", hint)
    ctx.register_command("chrome", lambda raw: command(hub, raw), description="Pair and manage the Hermes Chrome extension",
                         args_hint="[pair|status|devices|revoke <name>]")
    # No arguments, so it can appear in Telegram's / menu (shown there as /chrome_pair). Hyphenated on
    # purpose: the gateway maps /chrome_pair to chrome-pair before looking up plugin commands.
    ctx.register_command("chrome-pair", lambda raw: command(hub, "pair"), description="Pairing code for the Hermes Chrome extension")

    def _resume_deletes():  # owner only: clean up pairing messages left by a restart
        if hub.ready.wait(30) and hub.owner:
            telegram_note.resume(ctx.state)
    threading.Thread(target=_resume_deletes, daemon=True).start()
    ctx.register_cli_command("chrome", "Pair and manage the Hermes Chrome extension", setup_fn=_setup_cli,
                             handler_fn=lambda args: print(command(hub, " ".join([args.action, *args.rest]), cli=True)))
    ctx.register_skill("browser", Path(__file__).parent / "skill")


def _setup_cli(parser):
    parser.add_argument("action", nargs="?", default="help", choices=["pair", "status", "devices", "revoke", "help"])
    parser.add_argument("rest", nargs="*")


def command(hub: Hub, raw: str, cli: bool = False) -> str:
    action, _, arg = (raw or "").strip().partition(" ")
    action = action or "help"
    if action == "pair":
        if cli and hub.owner:
            return ("No running Hermes gateway is holding the browser port for this profile, so nothing would stay online "
                    "to receive the browser. Start the gateway, then run `hermes chrome pair` again (or send /chrome pair in chat).")
        try:
            code = hub.pair_code()
        except Exception as e:
            return f"Could not create a pairing code: {e}"
        where = None if cli else telegram_note.current_chat()
        if where and telegram_note.send_code(hub.ctx.state, where, code, CODE_TTL):
            return f"Pairing code sent. It works once and the message deletes itself in {CODE_TTL // 60} minutes."
        return (f"Pairing code (one use, valid {CODE_TTL // 60} minutes):\n\n{code}\n\n"
                "Paste it into the Hermes Chrome extension: right-click the icon → Settings → Pair.")
    if action == "status":
        st = hub.status()
        if st.get("connected"):
            names = ", ".join(f"{b['name']}{' (default)' if b.get('default') else ''}" for b in st.get("browsers") or [])
            return f"Connected: {names} via {st.get('address')}."
        n = len(st.get("devices") or [])
        return f"No browser connected. {n} paired browser(s). " + ("Run /chrome pair to add one." if not n else "Open Chrome to reconnect.")
    if action == "devices":
        devs = hub.status().get("devices") or []
        if not devs:
            return "No paired browsers. Run /chrome pair."
        return "\n".join(f"{d['name']} (id {d['id']}), last seen {datetime.fromtimestamp(d['last_seen']):%Y-%m-%d %H:%M}" for d in devs)
    if action == "revoke":
        if not arg:
            return "Usage: /chrome revoke <name or id | all>"
        gone = hub.revoke(arg.strip())
        return f"Unpaired {len(gone)} browser(s)." if gone else f"No paired browser matches {arg!r}."
    return HELP

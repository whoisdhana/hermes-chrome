"""Hermes Chrome: let the agent use the user's real Chrome through the Hermes Chrome extension.

Setup for users: enable the plugin, run /chrome pair, paste the code into the extension.
"""
from __future__ import annotations

import os
import re
import time
from pathlib import Path

import threading

from . import recordings, telegram_note
from .chat import _routed as chat_routed, bound as chat_bound
from .hub import CODE_TTL, EXTENSION_DOWNLOAD, PLUGIN_VERSION, Hub, default_port, version_tuple
from .tools import TOOLS, make_handler

HELP = """/chrome_pair      new pairing code for the Hermes Chrome extension (5 minutes, one use)
/chrome pair      same
/chrome status    is a browser connected?
/chrome devices   paired browsers (online or offline, last seen)
/chrome rename <name or id> to <new name>   rename a browser
/chrome prune [days]   forget browsers not seen for that many days (default 30)
/chrome revoke <name or id | all>   unpair a browser"""


def home_of() -> str:
    """Hermes home of the profile this plugin instance is being loaded for. Hermes knows (a shared gateway that serves
    several profiles switches homes without touching the HERMES_HOME variable); older versions only have the variable."""
    try:
        from hermes_constants import get_hermes_home
        return str(get_hermes_home())
    except Exception:
        return os.environ.get("HERMES_HOME", "")


def profile_of(ctx, home: str | None = None) -> str:
    """Which Hermes profile this plugin instance serves. The home is the ground truth (…/profiles/<name> for a named
    profile); ctx.profile_name has been seen to say "default" inside other profiles' gateways, which made them all
    claim the default profile's browser port."""
    m = re.search(r"/profiles/([^/]+)/*$", home_of() if home is None else home)
    return m.group(1) if m else (ctx.profile_name or "default")


def _plugins_block(text: str) -> tuple[list[str] | None, dict]:
    """From a Hermes config.yaml: the `plugins.enabled` list (None if absent) and hermes-chrome's settings. A small
    reader for just these keys, because the Python running a gateway does not always have PyYAML."""
    enabled, settings = None, {}
    lines = text.splitlines()
    in_plugins = False
    path: list[tuple[int, str]] = []  # (indent, key) under plugins:
    for raw in lines:
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        ind = len(raw) - len(raw.lstrip(" "))
        line = raw.strip()
        if ind == 0:
            in_plugins = line.startswith("plugins:")
            path = []
            continue
        if not in_plugins:
            continue
        while path and path[-1][0] >= ind:
            path.pop()
        keys = [k for _, k in path]
        if line.startswith("- "):
            if keys == ["enabled"]:
                enabled = (enabled or []) + [line[2:].strip().strip("'\"")]
            continue
        key, _, val = line.partition(":")
        key, val = key.strip().strip("'\""), val.split(" #")[0].strip().strip("'\"")
        if keys == [] and key == "enabled":
            enabled = [] if val in ("", "[]") else [v.strip().strip("'\"") for v in val.strip("[]").split(",") if v.strip()]
        if keys == ["entries", "hermes-chrome", "settings"] and val:
            settings[key] = val
        if not val:
            path.append((ind, key))
    return enabled, settings


def own_plugin_config(profile: str, home: str | None = None) -> dict | None:
    """For a named profile, this plugin's part of the profile's OWN config.yaml: whether it is enabled there and its
    settings. Hermes can load plugins installed in the main ~/.hermes into every profile and hand them the main
    profile's settings, so a profile that never enabled Hermes Chrome would otherwise run it on the main port.
    None for the default profile or when the file cannot be read."""
    if profile in ("default", "custom", ""):
        return None
    try:
        with open(os.path.join(home_of() if home is None else home, "config.yaml"), encoding="utf-8") as f:
            enabled, settings = _plugins_block(f.read())
    except OSError:
        return None
    return {"enabled": enabled is not None and "hermes-chrome" in enabled, "has_list": enabled is not None, "settings": settings}


def register(ctx):
    home = home_of()
    routed = chat_routed()
    profile = profile_of(ctx, home)
    own = own_plugin_config(profile, home)
    if own and own["has_list"] and not own["enabled"]:
        return  # this profile did not enable Hermes Chrome: no browser tools, no port
    named = profile not in ("default", "custom", "")
    # A named profile never takes the main profile's port: only its own setting, else its own default.
    port = (own["settings"].get("port") if own else None) or (None if named else ctx.get_config("port", default=None))
    hub = Hub(
        ctx,
        port=int(port or default_port(profile)),
        advertise_host=ctx.get_config("advertise_host", default=None) or None,
        public_url=ctx.get_config("public_url", default=None) or None,
        allow_lan=bool(ctx.get_config("allow_lan", default=False)),
        offline_message=ctx.get_config("offline_message", default="Browser not available"),
        agent_name=ctx.get_config("agent_name", default=None) or ("Hermes" if profile in ("default", "custom") else profile.title()),
        profile=profile,
        home=home if routed else None,  # only a profile served by a shared gateway needs its threads pinned
        remote_update=bool(ctx.get_config("remote_update", default=True)),
    )
    hub.start()

    for name, method, schema in TOOLS:
        ctx.register_tool(name=name, toolset="hermes_chrome", schema=schema, handler=make_handler(hub, name, method), emoji="🌐")

    cache = {"at": 0.0, "status": {}}
    told_update = set()  # (browser id, extension version) the agent was already told about

    def hint(user_message=None, **_):
        hub.note_request(user_message)
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
            def how(b):  # 0.8.0+ can update itself from the side panel; older copies need the manual way
                if version_tuple(b["extension"]) >= (0, 8, 0):
                    return "press Update now in its Hermes Chrome side panel (or, if that copy is loaded from a git checkout, git pull and press reload in the extensions page)"
                return (f"press reload on Hermes Chrome in that browser's extensions page (enough if it loads from a git checkout); otherwise download "
                        f"{EXTENSION_DOWNLOAD}, unzip it over the old extension folder and reload")
            update = "".join(f" Tell the user once, briefly: the Hermes Chrome extension in their browser \"{b['name']}\" is {b['extension']}, "
                             f"older than this plugin ({PLUGIN_VERSION}); to update it, {how(b)}." for b in stale[:3])
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
    threading.Thread(target=chat_bound(home, _resume_deletes) if routed else _resume_deletes, daemon=True).start()
    ctx.register_cli_command("chrome", "Pair and manage the Hermes Chrome extension", setup_fn=_setup_cli,
                             handler_fn=lambda args: print(command(hub, " ".join([args.action, *args.rest]), cli=True)))
    ctx.register_skill("browser", Path(__file__).parent / "skill")


def _setup_cli(parser):
    parser.add_argument("action", nargs="?", default="help", choices=["pair", "status", "devices", "revoke", "help"])
    parser.add_argument("rest", nargs="*")


def _ago(ts: float) -> str:
    s = max(0, time.time() - ts)
    for unit, n in (("day", 86400), ("hour", 3600), ("minute", 60)):
        if s >= n:
            k = int(s // n)
            return f"{k} {unit}{'s' if k != 1 else ''} ago"
    return "just now"


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
        def line(d):
            state = "● online" if d.get("online") else f"○ offline, last seen {_ago(d['last_seen'])}"
            stale = " (not seen for over 30 days: /chrome prune)" if not d.get("online") and time.time() - d["last_seen"] > 30 * 86400 else ""
            return f"{d['name']}{' · ' + d['browser'].split('/')[0] if d.get('browser') else ''}: {state}{stale}"
        return "\n".join(line(d) for d in sorted(devs, key=lambda d: (not d.get("online"), -d["last_seen"])))
    if action == "rename":
        old, sep, new = arg.partition(" to ")
        if not sep or not old.strip() or not new.strip():
            return "Usage: /chrome rename <name or id> to <new name>"
        did = hub.rename(old.strip(), new.strip())
        return f"Renamed to {new.strip()[:60]!r}." if did else f"No single paired browser matches {old.strip()!r}. See /chrome devices."
    if action == "prune":
        try:
            days = float(arg) if arg.strip() else 30
        except ValueError:
            return "Usage: /chrome prune [days]"
        gone = hub.prune(days)
        return f"Forgot {len(gone)} browser(s) not seen for {days:g} days." if gone else f"No browser has been away for {days:g} days." 
    if action == "revoke":
        if not arg:
            return "Usage: /chrome revoke <name or id | all>"
        gone = hub.revoke(arg.strip())
        return f"Unpaired {len(gone)} browser(s)." if gone else f"No paired browser matches {arg!r}."
    return HELP

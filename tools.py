"""chrome_* tools: schemas + handlers. Each handler forwards to the extension through the hub."""
from __future__ import annotations

import base64
import json
import time
from pathlib import Path

from . import recordings, telegram_note
from .hub import BrowserUnavailable

TAB = {"type": "integer", "description": "Tab id from chrome_tabs / chrome_open. Omit to use the most recent agent tab."}
REF = {"type": "string", "description": 'Element ref from chrome_read_page or chrome_find, e.g. "e12".'}
WHY = {"type": "string", "description": 'Short reason shown to the user next to the cursor, e.g. "Opening the export menu". Always include it.'}


def _schema(name, description, props=None, required=None):
    return {"name": name, "description": description,
            "parameters": {"type": "object", "properties": props or {}, "required": required or []}}


# (tool name, extension method, schema)
TOOLS = [
    ("chrome_status", None, _schema("chrome_status",
        "Which of the user's browsers are connected (by name; the default is marked) and the agent's tabs. Call this first for browser work.")),
    ("chrome_tabs", "tabs_list", _schema("chrome_tabs", "List the tabs in the agent's tab group.")),
    ("chrome_open", "tab_open", _schema("chrome_open",
        "Open a URL in the agent's tab in the user's real Chrome (their logins and cookies) and wait for it to load. "
        "By default this reuses your main tab. Set newTab=true only to work on several pages side by side (research, "
        "comparing options); those extra tabs close when you call chrome_report.",
        {"url": {"type": "string"}, "why": WHY,
         "newTab": {"type": "boolean", "description": "Open an extra tab instead of reusing the main one (parallel research only)."}}, ["url"])),
    ("chrome_close", "tab_close", _schema("chrome_close", "Close one of the agent's tabs.", {"tabId": TAB})),
    ("chrome_navigate", "navigate", _schema("chrome_navigate",
        'Navigate a tab to a URL and wait for load. Use "back" or "forward" for history.',
        {"tabId": TAB, "url": {"type": "string"}, "why": WHY}, ["url"])),
    ("chrome_read_page", "read_page", _schema("chrome_read_page",
        "Outline of the page: interactive elements (plus headings and text when interactiveOnly=false) with refs for chrome_click / chrome_type.",
        {"tabId": TAB, "interactiveOnly": {"type": "boolean"}})),
    ("chrome_find", "find", _schema("chrome_find",
        "Find elements whose text, label, placeholder or role matches the query. Returns refs.",
        {"tabId": TAB, "query": {"type": "string"}}, ["query"])),
    ("chrome_text", "get_text", _schema("chrome_text", "Visible text of the page (truncated).",
        {"tabId": TAB, "maxChars": {"type": "integer"}})),
    ("chrome_screenshot", "screenshot", _schema("chrome_screenshot", "Screenshot of the visible part of the tab.", {"tabId": TAB})),
    ("chrome_click", "click", _schema("chrome_click",
        "Click an element by ref (or viewport x,y). Risky clicks (pay, delete, send, post) ask the user in the browser first.",
        {"tabId": TAB, "ref": REF, "x": {"type": "number"}, "y": {"type": "number"},
         "double": {"type": "boolean"}, "button": {"type": "string", "enum": ["left", "right", "middle"]}, "why": WHY})),
    ("chrome_type", "type", _schema("chrome_type",
        "Type text, optionally into an element by ref (clicked first). clear=true empties it first; submit=true presses Enter after.",
        {"tabId": TAB, "ref": REF, "text": {"type": "string"}, "clear": {"type": "boolean"}, "submit": {"type": "boolean"}, "why": WHY}, ["text"])),
    ("chrome_key", "press_key", _schema("chrome_key",
        'Press a key or chord, e.g. "Enter", "Tab", "Escape", "ArrowDown", "Control+a".',
        {"tabId": TAB, "key": {"type": "string"}, "why": WHY}, ["key"])),
    ("chrome_scroll", "scroll", _schema("chrome_scroll", "Scroll the page, or scroll an element (ref) into view.",
        {"tabId": TAB, "ref": REF, "direction": {"type": "string", "enum": ["up", "down", "left", "right"]},
         "amount": {"type": "number"}, "why": WHY})),
    ("chrome_wait", "wait", _schema("chrome_wait", "Wait up to 15000 ms for the page to settle.",
        {"tabId": TAB, "ms": {"type": "integer"}}, ["ms"])),
    ("chrome_handoff", "handoff", _schema("chrome_handoff",
        "Ask the user to do a step themselves in the page (CAPTCHA, login, 2FA, payment confirmation). Shows a banner in their "
        "browser and waits until they press Done. Never try to solve CAPTCHAs yourself.",
        {"tabId": TAB, "message": {"type": "string"}, "timeoutSec": {"type": "integer"}}, ["message"])),
    ("chrome_eval", "eval_js", _schema("chrome_eval",
        "Run a JavaScript expression in the page. Disabled unless the user enabled it in the extension settings.",
        {"tabId": TAB, "expression": {"type": "string"}}, ["expression"])),
    ("chrome_plan", "plan", _schema("chrome_plan",
        "Show your plan in the user's browser as a progress strip. For any task of 3+ steps: call once with steps (short, user-facing), "
        "then with done=N as you finish each step.",
        {"steps": {"type": "array", "items": {"type": "string"}}, "done": {"type": "integer"}})),
    ("chrome_report", "report", _schema("chrome_report",
        "Finish a browser task: send the user a short summary with snapshots of the last steps. Call once at the end of multi-step work.",
        {"summary": {"type": "string"}}, ["summary"])),
    ("chrome_replay", None, _schema("chrome_replay",
        "Run a browser workflow the user recorded (a skill under browser-recordings). Omit name to list them. vars fills {{placeholders}}.",
        {"name": {"type": "string"}, "vars": {"type": "object", "additionalProperties": {"type": "string"}}})),
]


BROWSER = {"type": "string", "description": 'Which connected browser to use, by name (see chrome_status), e.g. "Work Chrome". '
           "Omit to use the one you used last."}
for _name, _method, _schema_ in TOOLS:
    _schema_["parameters"]["properties"]["browser"] = BROWSER


def make_handler(hub, tool: str, method: str | None):
    def handler(args: dict, **kwargs):
        try:
            if tool == "chrome_status":
                st = hub.status()
                if not st.get("connected"):
                    return hub.offline_message
                st["tabs"] = (hub.call("tabs_list", {"browser": args.get("browser")}, 15) or {}).get("tabs", [])
                st["recorded_workflows"] = recordings.names()
                return json.dumps(st)
            if tool == "chrome_replay":
                return _replay(hub, args)
            if tool == "chrome_handoff":  # also ping the user where they talk to the agent
                telegram_note.notify(f"✋ {hub.agent_name} needs you in Chrome: {args.get('message', '')}")
            timeout = (int(args.get("timeoutSec") or 600) + 15) if tool == "chrome_handoff" else 60
            result = hub.call(method, args, timeout)
        except BrowserUnavailable as e:
            return str(e)
        except Exception as e:
            return json.dumps({"error": str(e)})
        if tool == "chrome_screenshot" and isinstance(result, dict) and result.get("image"):
            return _screenshot_result(hub, result)
        if tool == "chrome_report" and isinstance(result, dict):
            return _report_result(hub, args, result)
        if isinstance(result, dict) and "text" in result:
            return result["text"]
        return json.dumps(result)
    return handler


def _replay(hub, args: dict) -> str:
    name = (args.get("name") or "").strip()
    if not name:
        found = recordings.names()
        return "Recorded workflows: " + ", ".join(found) if found else "No recorded workflows yet. The user records them in the side panel's Teach tab."
    data = recordings.load(name)
    if not data:
        return f'No recorded workflow "{name}". Available: {", ".join(recordings.names()) or "none"}.'
    steps, missing = recordings.fill(data["steps"], args.get("vars") or {})
    if missing:
        return f'"{name}" needs values for: {", ".join(missing)}. Ask the user (or use values you already know), then call chrome_replay again with vars.'
    return hub.call("replay", {"name": data["name"], "steps": steps, "browser": args.get("browser")}, 120 + 45 * len(steps))["text"]


def _report_result(hub, args: dict, result: dict) -> str:
    stats = json.loads(result.get("text") or "{}")
    shots = [(base64.b64decode(i["data"].split(",", 1)[1]), i.get("label", "")) for i in result.get("images") or []]
    line = f"✅ {args.get('summary', 'Done')}\n{stats.get('steps', 0)} steps in {stats.get('seconds', 0)} s"
    if stats.get("handoffs"):
        line += f", {stats['handoffs']} handed to you"
    sent = telegram_note.send_report(line, shots)
    return json.dumps({**stats, "sent_to_telegram": sent,
                       "note": "Report delivered with snapshots." if sent else "Tell the user the summary in your reply."})


def _screenshot_result(hub, result: dict):
    folder = Path(hub.ctx.state.data_dir) / "screenshots"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{time.strftime('%Y%m%d-%H%M%S')}.jpg"
    path.write_bytes(base64.b64decode(result["image"]["data"]))
    for old in sorted(folder.glob("*.jpg"))[:-50]:  # keep the last 50
        old.unlink(missing_ok=True)
    text = f"{result.get('text', '')}\nMEDIA:{path}"
    try:  # show the image to the model natively when the route supports it (same path MCP image results use)
        from tools.mcp_tool_content import _mcp_result_with_native_images
        return _mcp_result_with_native_images(text, [str(path)])
    except Exception:
        return text

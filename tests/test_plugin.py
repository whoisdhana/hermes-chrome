"""Plugin tests without Hermes: a fake plugin context, a fake extension (WebSocket) and a mock API server.

Run with any Python that has aiohttp (Hermes' venv has it):
  python -m unittest discover -s tests
"""
import asyncio
import csv
import importlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

from aiohttp import ClientSession, web

ROOT = Path(__file__).resolve().parents[1]
# The repo root is the plugin package (that is how `hermes plugins install` lays it out); load it as hermes_chrome.
_spec = importlib.util.spec_from_file_location("hermes_chrome", ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
plugin = importlib.util.module_from_spec(_spec)
sys.modules["hermes_chrome"] = plugin
_spec.loader.exec_module(plugin)
hub_mod = importlib.import_module("hermes_chrome.hub")


class FakeState:
    def __init__(self, folder):
        self.data_dir = folder
        self._file = Path(folder) / "state.json"

    def get(self, key, default=None):
        try:
            return json.loads(self._file.read_text()).get(key, default)
        except (OSError, ValueError):
            return default

    def set(self, key, value):
        try:
            data = json.loads(self._file.read_text())
        except (OSError, ValueError):
            data = {}
        data[key] = value
        self._file.write_text(json.dumps(data))


class FakeCtx:
    def __init__(self, folder, config):
        self.state = FakeState(folder)
        self.profile_name = "default"
        self._config = config
        self.tools, self.hooks, self.commands, self.cli, self.skills = {}, {}, {}, {}, {}

    def get_config(self, key, default=None):
        return self._config.get(key, default)

    def register_tool(self, name, toolset, schema, handler, **kw):
        self.tools[name] = handler

    def register_hook(self, name, fn):
        self.hooks[name] = fn

    def register_command(self, name, fn, **kw):
        self.commands[name] = fn

    def register_cli_command(self, name, help, setup_fn, handler_fn=None, **kw):
        self.cli[name] = handler_fn

    def register_skill(self, name, path):
        self.skills[name] = path


def run_async(coro):
    return asyncio.run(coro)


class FakeExtension:
    """Answers tool calls like the real extension would, from a background thread."""

    def __init__(self, port):
        self.port = port
        self.calls = []
        self.events = []
        self.loop = asyncio.new_event_loop()
        self.ws = None
        self.closed_code = None
        threading.Thread(target=self.loop.run_forever, daemon=True).start()

    def run(self, coro, timeout=10):
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout)

    async def pair(self, code):
        async with ClientSession() as s:
            async with s.ws_connect(f"http://127.0.0.1:{self.port}/ext") as ws:
                await ws.send_json({"type": "pair", "code": code, "deviceName": "Test Chrome"})
                return json.loads((await ws.receive()).data)

    async def connect(self, device_id, key, name=None):
        self.closed_code = None
        self.session = ClientSession()
        self.ws = await self.session.ws_connect(f"http://127.0.0.1:{self.port}/ext")
        await self.ws.send_json({"type": "hello", "deviceId": device_id, "deviceKey": key, "browser": "Chrome/1", "version": "t",
                                 "deviceName": name})
        first = await self.ws.receive()
        if first.type != 1:  # not TEXT: server closed us
            self.closed_code = self.ws.close_code
            return None
        asyncio.ensure_future(self._loop())
        return json.loads(first.data)

    async def _loop(self):
        async for m in self.ws:
            data = json.loads(m.data)
            if data.get("type") in ("chat_event", "chat_meta", "skill_saved", "recordings", "recording_run", "intent_result", "set_name"):
                self.events.append(data)
            elif "id" in data:
                self.calls.append(data)
                result = {"tabs": [{"tabId": 7}]} if data["method"] == "tabs_list" else {"text": f"did {data['method']}"}
                if data["method"] == "report":
                    result = {"text": json.dumps({"steps": 4, "handoffs": 1, "seconds": 30}),
                              "images": [{"data": "data:image/jpeg;base64,/9j/AAAA", "label": "Clicked Export"}]}
                await self.ws.send_json({"id": data["id"], "result": result})
        self.closed_code = self.ws.close_code

    async def send(self, msg):
        await self.ws.send_json(msg)

    async def close(self):
        await self.ws.close()
        await self.session.close()


def wait_for(pred, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.05)
    return False


class PluginTest(unittest.TestCase):
    PORT = 18798

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.ctx = FakeCtx(cls.tmp, {"port": cls.PORT, "advertise_host": "127.0.0.1", "offline_message": "MacBook not available",
                                    "agent_name": "Delulu"})
        plugin.register(cls.ctx)
        assert wait_for(lambda: cls._hub().owner), "owner hub did not bind"

    @classmethod
    def _hub(cls):
        return cls.ctx.tools["chrome_open"].__closure__[0].cell_contents  # make_handler closes over hub first

    def test_1_registers_everything(self):
        self.assertEqual(len(self.ctx.tools), 22)
        self.assertIn("pre_llm_call", self.ctx.hooks)
        self.assertIn("chrome", self.ctx.commands)
        self.assertTrue((Path(self.ctx.skills["browser"]) / "SKILL.md").exists())

    def test_2_offline_and_hint_before_pairing(self):
        self.assertEqual(self.ctx.tools["chrome_open"]({"url": "https://x"}), "MacBook not available")
        self.assertIsNone(self.ctx.hooks["pre_llm_call"](session_id="s"))  # never paired: say nothing

    def test_3_pairing_flow(self):
        out = self.ctx.commands["chrome"]("pair")
        code = next(l for l in out.splitlines() if l.startswith("HC-"))
        self.assertRegex(code, rf"^HC-[2-9A-Z]{{4}}-[2-9A-Z]{{4}}@127\.0\.0\.1:{self.PORT}$")
        ext = FakeExtension(self.PORT)
        self.assertEqual(ext.run(ext.pair("HC-2222-2222"))["type"], "pair_failed")
        paired = ext.run(ext.pair(code))
        self.assertEqual(paired["type"], "paired")
        self.assertEqual(paired["agentName"], "Delulu")
        self.assertEqual(ext.run(ext.pair(code))["type"], "pair_failed", "codes are single use")
        devices = self.ctx.state.get("devices")
        self.assertEqual(len(devices), 1)
        self.assertNotIn(paired["deviceKey"], json.dumps(devices), "only a hash is stored")

        self.assertIsNone(ext.run(ext.connect(paired["deviceId"], "wrong-key")))
        self.assertEqual(ext.closed_code, 4001)
        welcome = ext.run(ext.connect(paired["deviceId"], paired["deviceKey"], "Work MacBook"))
        self.assertEqual(welcome["type"], "welcome")
        self.assertEqual(self.ctx.state.get("devices")[paired["deviceId"]]["name"], "Work MacBook", "rename on connect")
        self.assertTrue(wait_for(lambda: self._hub().connected))
        type(self).ext, type(self).device = ext, paired

    def test_4_tools_hint_and_status(self):
        ext = self.ext
        self.assertEqual(self.ctx.tools["chrome_open"]({"url": "https://example.com"}), "did tab_open")
        self.assertEqual(ext.calls[-1]["method"], "tab_open")
        st = json.loads(self.ctx.tools["chrome_status"]({}))
        self.assertTrue(st["connected"])
        self.assertEqual(st["device"], "Work MacBook", "status names the live browser")
        self.assertEqual(st["tabs"], [{"tabId": 7}])
        time.sleep(5.1)  # hint caches status for 5 s
        self.assertIn('Chrome "Work MacBook" is connected', self.ctx.hooks["pre_llm_call"](session_id="s"))
        self.assertIn("Connected: Work MacBook", self.ctx.commands["chrome"]("status"))
        self.assertIn("Work MacBook", self.ctx.commands["chrome"]("devices"))

    def test_5_client_process_forwards_to_owner(self):
        ctx2 = FakeCtx(self.tmp, dict(self.ctx._config))  # same profile state, second process
        plugin.register(ctx2)
        hub2 = ctx2.tools["chrome_open"].__closure__[0].cell_contents
        self.assertTrue(hub2.ready.wait(5))
        self.assertFalse(hub2.owner)
        self.assertEqual(ctx2.tools["chrome_navigate"]({"url": "back"}), "did navigate")
        self.assertIn("HC-", ctx2.commands["chrome"]("pair"))
        self.assertIn("No running Hermes gateway", plugin.command(self._hub(), "pair", cli=True), "CLI owner warns")

    def test_6_chat_relay(self):
        seen = []

        async def responses(request):
            seen.append({"auth": request.headers.get("authorization"), "body": await request.json()})
            resp = web.StreamResponse(headers={"content-type": "text/event-stream"})
            await resp.prepare(request)
            for ev in ({"type": "response.output_item.done", "item": {"type": "function_call", "name": "chrome_read_page", "arguments": "{}"}},
                       {"type": "response.output_text.delta", "item_id": "m", "delta": "Hi "},
                       {"type": "response.output_text.delta", "item_id": "m", "delta": "there"}):
                await resp.write(f"event: {ev['type']}\ndata: {json.dumps(ev)}\n\n".encode())
            return resp

        async def options(request):
            return web.json_response({"model": "m1", "provider": "p1", "providers": [
                {"slug": "p1", "name": "P1", "authenticated": True, "models": ["m1", "m2"]},
                {"slug": "p2", "name": "P2", "authenticated": False, "models": []}]})

        loop = asyncio.new_event_loop()
        threading.Thread(target=loop.run_forever, daemon=True).start()

        async def start():
            app = web.Application()
            app.router.add_post("/v1/responses", responses)
            app.router.add_get("/api/model/options", options)
            runner = web.AppRunner(app)
            await runner.setup()
            await web.TCPSite(runner, "127.0.0.1", 18642).start()
        asyncio.run_coroutine_threadsafe(start(), loop).result(5)
        os.environ.update(API_SERVER_PORT="18642", API_SERVER_KEY="k-test")
        skills = Path(self.tmp) / "home" / "skills" / "research" / "deep-dive"
        skills.mkdir(parents=True)
        (skills / "SKILL.md").write_text("---\nname: deep-dive\ndescription: Research a topic\n---\nbody")
        os.environ["HERMES_HOME"] = str(Path(self.tmp) / "home")

        ext = self.ext
        ext.run(ext.send({"type": "chat_meta"}))
        self.assertTrue(wait_for(lambda: any(e["type"] == "chat_meta" for e in ext.events)))
        meta = next(e for e in ext.events if e["type"] == "chat_meta")
        self.assertEqual([p["slug"] for p in meta["models"]["providers"]], ["p1"])
        self.assertEqual(meta["skills"], [{"name": "deep-dive", "description": "Research a topic"}])

        ext.run(ext.send({"type": "chat", "chatId": "c1", "conversation": "conv", "text": "hello", "model": "m2", "provider": "p1",
                          "images": ["data:image/png;base64,AAAA"], "files": [{"name": "a b.txt", "data": "aGk="}]}))
        self.assertTrue(wait_for(lambda: any(e.get("kind") == "done" for e in ext.events)))
        kinds = [e["kind"] for e in ext.events if e["type"] == "chat_event"]
        self.assertEqual(kinds, ["tool", "delta", "delta", "done"])
        body = seen[-1]["body"]
        self.assertEqual(seen[-1]["auth"], "Bearer k-test")
        self.assertEqual((body["model"], body["provider"], body["conversation"]), ("m2", "p1", "conv"))
        text = body["input"][0]["content"][0]["text"]
        path = text.split("saved on this machine: ")[1].split(". Read them")[0]
        self.assertEqual(Path(path).read_text(), "hi")
        self.assertEqual(body["input"][0]["content"][1], {"type": "input_image", "image_url": "data:image/png;base64,AAAA"})

    def test_6b_teach_save_replay_report(self):
        ext, tn = self.ext, importlib.import_module("hermes_chrome.telegram_note")
        steps = [{"action": "open", "url": "https://ads.example.com/"},
                 {"action": "type", "target": {"name": "Report date", "css": "#d"}, "value": "{{date}}"},
                 {"action": "type", "target": {"name": "Password", "css": "#p"}, "secret": True, "value": "hunter2"},
                 {"action": "click", "target": {"role": "button", "name": "Export"}},
                 {"action": "bogus"}]
        ext.run(ext.send({"type": "save_skill", "id": "s1", "name": "Ads Weekly Export", "description": "Export last week", "steps": steps}))
        self.assertTrue(wait_for(lambda: any(e.get("type") == "skill_saved" for e in ext.events) or
                                 (Path(os.environ["HERMES_HOME"]) / "skills/browser-recordings/ads-weekly-export/SKILL.md").exists()))
        folder = Path(os.environ["HERMES_HOME"]) / "skills" / "browser-recordings" / "ads-weekly-export"
        skill = (folder / "SKILL.md").read_text()
        self.assertIn("name: ads-weekly-export", skill)
        self.assertIn("chrome_replay", skill)
        saved = json.loads((folder / "steps.json").read_text())["steps"]
        self.assertEqual(len(saved), 4, "unknown actions dropped")
        self.assertNotIn("hunter2", json.dumps(saved), "secrets never stored")

        replay = self.ctx.tools["chrome_replay"]
        self.assertIn("ads-weekly-export", replay({}))
        self.assertIn("needs values for: date", replay({"name": "ads-weekly-export"}))
        self.assertEqual(replay({"name": "ads-weekly-export", "vars": {"date": "2026-10-20"}}), "did replay")
        sent = ext.calls[-1]["params"]["steps"]
        self.assertEqual(sent[1]["value"], "2026-10-20")
        # side panel: list, run (asks for values first), delete
        ext.run(ext.send({"type": "list_recordings"}))
        self.assertTrue(wait_for(lambda: any(e["type"] == "recordings" for e in ext.events)))
        items = [e for e in ext.events if e["type"] == "recordings"][-1]["items"]
        self.assertEqual([(i["name"], i["vars"]) for i in items], [("ads-weekly-export", ["date"])])
        ext.run(ext.send({"type": "run_recording", "id": "r1", "name": "ads-weekly-export"}))
        self.assertTrue(wait_for(lambda: any(e["type"] == "recording_run" for e in ext.events)))
        self.assertEqual([e for e in ext.events if e["type"] == "recording_run"][-1]["missing"], ["date"])
        ext.run(ext.send({"type": "run_recording", "id": "r2", "name": "ads-weekly-export", "vars": {"date": "2026-10-27"}}))
        self.assertTrue(wait_for(lambda: any(e["type"] == "recording_run" and e.get("ok") for e in ext.events)))
        self.assertEqual(ext.calls[-1]["params"]["steps"][1]["value"], "2026-10-27")
        self.assertNotIn("browser", ext.calls[-1]["params"])
        time.sleep(5.1)
        self.assertIn("Recorded workflows (run with chrome_replay): ads-weekly-export", self.ctx.hooks["pre_llm_call"](session_id="s"))

        calls = []
        orig = (tn._bot, tn._multipart, tn.current_chat, tn._token)
        tn._bot = lambda m, p: calls.append((m, p)) or {"ok": True, "result": {"message_id": 1}}
        tn._multipart = lambda m, f, files: calls.append((m, f, sorted(files))) or {"ok": True}
        tn.current_chat = lambda: ("4242", "", "")
        tn._token = lambda: "t"
        try:
            out = json.loads(self.ctx.tools["chrome_report"]({"summary": "Exported the report"}))
            self.assertEqual((out["steps"], out["sent_to_telegram"]), (4, True))
            method, fields, files = calls[-1]
            self.assertEqual((method, files), ("sendMediaGroup", ["p0"]))
            self.assertIn("Exported the report", fields["media"])
            self.ctx.tools["chrome_handoff"]({"message": "Solve the CAPTCHA"})
            self.assertIn("needs you in Chrome: Solve the CAPTCHA", calls[-1][1]["text"])
        finally:
            tn._bot, tn._multipart, tn.current_chat, tn._token = orig

    def test_6c_two_browsers_at_once(self):
        main = self.ext
        code = next(l for l in self.ctx.commands["chrome"]("pair").splitlines() if l.startswith("HC-"))
        brave = FakeExtension(self.PORT)
        paired = brave.run(brave.pair(code))
        self.assertEqual(brave.run(brave.connect(paired["deviceId"], paired["deviceKey"], "Brave Work"))["type"], "welcome")
        time.sleep(0.5)
        self.assertIsNone(main.closed_code, "a second browser must not knock the first one off")
        st = self._hub().status()
        self.assertEqual(sorted(b["name"] for b in st["browsers"]), ["Brave Work", "Work MacBook"])

        open_ = self.ctx.tools["chrome_open"]
        n_main, n_brave = len(main.calls), len(brave.calls)
        open_({"url": "https://a.example", "browser": "brave"})
        self.assertEqual((len(main.calls), len(brave.calls)), (n_main, n_brave + 1), "routed by (partial) name")
        self.assertNotIn("browser", brave.calls[-1]["params"], "the browser choice is not forwarded")
        open_({"url": "https://b.example"})
        self.assertEqual(len(brave.calls), n_brave + 2, "default = the browser used last")
        open_({"url": "https://c.example", "browser": "Work MacBook"})
        self.assertEqual(len(main.calls), n_main + 1)
        self.assertIn("No connected browser called", open_({"url": "https://d", "browser": "Firefox"}))
        time.sleep(5.1)
        self.assertIn('"Brave Work"', self.ctx.hooks["pre_llm_call"](session_id="s"))

        brave.run(brave.close())
        self.assertTrue(wait_for(lambda: len(self._hub().status()["browsers"]) == 1))
        self.assertEqual(open_({"url": "https://e.example"}), "did tab_open", "falls back to the browser still connected")
        self.assertIsNone(main.closed_code)
        self.ctx.commands["chrome"]("revoke Brave Work")

    def test_7_revoke_drops_connection(self):
        ext = self.ext
        self.assertIn("Unpaired 1", self.ctx.commands["chrome"]("revoke Work MacBook"))
        self.assertTrue(wait_for(lambda: ext.closed_code == 4001))
        self.assertTrue(wait_for(lambda: not self._hub().connected))
        self.assertEqual(self.ctx.tools["chrome_click"]({"ref": "e1"}), "MacBook not available")
        time.sleep(5.1)  # past the hint's status cache
        self.assertIsNone(self.ctx.hooks["pre_llm_call"](session_id="s"), "no paired browsers left: no hint")


class UpdateNoticeTest(unittest.TestCase):
    """The plugin tells the extension its version, and tells the agent once when a browser runs an older extension."""
    PORT = 18795

    def test_welcome_version_and_one_time_hint(self):
        ctx = FakeCtx(tempfile.mkdtemp(), {"port": self.PORT, "advertise_host": "127.0.0.1", "agent_name": "Delulu"})
        plugin.register(ctx)
        hub = ctx.tools["chrome_open"].__closure__[0].cell_contents
        self.assertTrue(wait_for(lambda: hub.owner))
        code = next(l for l in ctx.commands["chrome"]("pair").splitlines() if l.startswith("HC-"))
        ext = FakeExtension(self.PORT)
        paired = ext.run(ext.pair(code))

        async def hello(version):
            ext.session = ClientSession()
            ext.ws = await ext.session.ws_connect(f"http://127.0.0.1:{self.PORT}/ext")
            await ext.ws.send_json({"type": "hello", "deviceId": paired["deviceId"], "deviceKey": paired["deviceKey"],
                                    "browser": "Chrome/1", "version": version, "deviceName": "Old Chrome"})
            return json.loads((await ext.ws.receive()).data)
        welcome = ext.run(hello("0.0.1"))
        self.assertEqual(welcome["pluginVersion"], hub_mod.PLUGIN_VERSION)
        self.assertRegex(hub_mod.PLUGIN_VERSION, r"^\d+\.\d+\.\d+$")
        time.sleep(5.1)  # past the hint's status cache
        first = ctx.hooks["pre_llm_call"](session_id="s")
        self.assertIn("older than this plugin", first)
        self.assertIn(hub_mod.EXTENSION_DOWNLOAD, first)
        self.assertNotIn("older than this plugin", ctx.hooks["pre_llm_call"](session_id="s"), "said once, not every turn")


class IntentCheckTest(unittest.TestCase):
    """Risky actions are checked against the user's latest message with the user's own model."""
    PORT = 18794

    def test_judge_and_websocket_round_trip(self):
        ctx = FakeCtx(tempfile.mkdtemp(), {"port": self.PORT, "advertise_host": "127.0.0.1", "agent_name": "Delulu"})
        answers = []

        class FakeLlm:
            def complete(self, messages, **kw):
                answers.append(messages)
                reply = next_reply.pop(0)
                if isinstance(reply, Exception):
                    raise reply
                return type("R", (), {"text": reply})()
        next_reply = []
        ctx.llm = FakeLlm()
        plugin.register(ctx)
        hub = ctx.tools["chrome_open"].__closure__[0].cell_contents
        self.assertTrue(wait_for(lambda: hub.owner))
        check = {"action": "click", "target": 'button "Send"', "url": "https://mail.example.com", "why": "Sending the email"}

        self.assertEqual(hub.judge(check), {"ok": True, "skipped": "no recent request"})
        ctx.hooks["pre_llm_call"](session_id="s", user_message="Summarise my inbox, do not send anything")
        next_reply.append('Sure: {"ok": false, "reason": "You asked for a summary, not to send an email."}')
        self.assertEqual(hub.judge(check), {"ok": False, "reason": "You asked for a summary, not to send an email."})
        self.assertIn("Summarise my inbox", answers[-1][1]["content"], "the user's request goes to the model")
        self.assertIn('button "Send"', answers[-1][1]["content"])
        next_reply.append('{"ok": true}')
        self.assertEqual(hub.judge(check), {"ok": True})
        next_reply.append(RuntimeError("no auth"))
        self.assertEqual(hub.judge(check), {"ok": True, "skipped": "check unavailable"}, "a broken model never blocks")

        code = next(l for l in ctx.commands["chrome"]("pair").splitlines() if l.startswith("HC-"))
        ext = FakeExtension(self.PORT)
        paired = ext.run(ext.pair(code))
        welcome = ext.run(ext.connect(paired["deviceId"], paired["deviceKey"]))
        self.assertTrue(welcome["intentCheck"])
        next_reply.append('{"ok": false, "reason": "Not asked for."}')

        # FakeExtension only records chat-type events; listen on the raw socket instead
        async def ask_raw():
            await ext.ws.send_json({"type": "intent_check", "id": "c1", **check})
        ext.run(ask_raw())
        self.assertTrue(wait_for(lambda: any(e.get("type") == "intent_result" for e in ext.events), 5))
        res = next(e for e in ext.events if e.get("type") == "intent_result")
        self.assertEqual((res["id"], res["ok"], res["reason"]), ("c1", False, "Not asked for."))


class DevicesTest(unittest.TestCase):
    """Online/offline listing, renaming from chat (live and offline), pruning browsers that went away."""
    PORT = 18793

    def test_devices_rename_prune(self):
        ctx = FakeCtx(tempfile.mkdtemp(), {"port": self.PORT, "advertise_host": "127.0.0.1", "agent_name": "Delulu"})
        plugin.register(ctx)
        hub = ctx.tools["chrome_open"].__closure__[0].cell_contents
        self.assertTrue(wait_for(lambda: hub.owner))
        cmd = ctx.commands["chrome"]
        pair = lambda: FakeExtension(self.PORT)
        a, b = pair(), pair()
        code = lambda: next(l for l in cmd("pair").splitlines() if l.startswith("HC-"))
        pa, pb = a.run(a.pair(code())), b.run(b.pair(code()))
        a.run(a.connect(pa["deviceId"], pa["deviceKey"], "Work Brave"))
        self.assertTrue(wait_for(lambda: hub.connected))
        listing = cmd("devices")
        self.assertRegex(listing, r"Work Brave · Chrome: ● online")
        self.assertIn("○ offline", listing)
        # rename the connected browser: it is told at once
        self.assertIn("Renamed", cmd("rename Work Brave to Agency Brave"))
        self.assertTrue(wait_for(lambda: any(e.get("type") == "set_name" and e.get("name") == "Agency Brave" for e in a.events), 5))
        # rename the offline one: it adopts the name when it next connects
        self.assertIn("Renamed", cmd(f"rename {pb['deviceId']} to Home Chrome"))
        welcome = b.run(b.connect(pb["deviceId"], pb["deviceKey"], "Test Chrome"))
        self.assertEqual(welcome["type"], "welcome")
        self.assertTrue(wait_for(lambda: any(e.get("type") == "set_name" and e.get("name") == "Home Chrome" for e in b.events), 5))
        self.assertEqual(ctx.state.get("devices")[pb["deviceId"]]["name"], "Home Chrome")
        self.assertIn("Usage", cmd("rename nothing"))
        # prune: only browsers that are away
        b.run(b.close())
        self.assertTrue(wait_for(lambda: pb["deviceId"] not in [d for d, c in hub.conns.items() if not c["ws"].closed], 5))
        devices = ctx.state.get("devices")
        devices[pb["deviceId"]]["last_seen"] -= 40 * 86400
        devices[pa["deviceId"]]["last_seen"] -= 40 * 86400  # connected right now, so it stays
        ctx.state.set("devices", devices)
        self.assertIn("not seen for over 30 days", cmd("devices"))
        self.assertIn("Forgot 1 browser", cmd("prune 30"))
        self.assertEqual(list(ctx.state.get("devices")), [pa["deviceId"]])


class PortClashTest(unittest.TestCase):
    """Two Hermes profiles on one machine: each gets its own default port, and a clash is explained, not hidden."""
    PORT = 18792

    def test_default_ports_and_clash_message(self):
        self.assertEqual(hub_mod.default_port("default"), 8798)
        ports = {hub_mod.default_port(p) for p in ("finance", "maya", "nora_accounts", "nora_research", "vulcan")}
        self.assertEqual(len(ports), 5, "distinct per profile")
        self.assertTrue(all(8800 <= p < 9000 for p in ports))
        owner = FakeCtx(tempfile.mkdtemp(), {"port": self.PORT, "advertise_host": "127.0.0.1"})
        owner.profile_name = "nora_research"
        plugin.register(owner)
        hub1 = owner.tools["chrome_open"].__closure__[0].cell_contents
        self.assertTrue(wait_for(lambda: hub1.owner))
        other = FakeCtx(tempfile.mkdtemp(), {"port": self.PORT, "advertise_host": "127.0.0.1"})  # its own state and secret
        plugin.register(other)
        hub2 = other.tools["chrome_open"].__closure__[0].cell_contents
        self.assertTrue(hub2.ready.wait(5))
        self.assertFalse(hub2.owner)
        out = other.commands["chrome"]("pair")
        self.assertIn('in use by the Hermes profile "nora_research"', out)
        self.assertIn("settings.port", out)

    def test_profile_comes_from_hermes_home(self):
        ctx = FakeCtx(tempfile.mkdtemp(), {})
        ctx.profile_name = "default"  # what Hermes reported inside other profiles' gateways
        old = os.environ.get("HERMES_HOME")
        try:
            os.environ["HERMES_HOME"] = "/home/u/.hermes/profiles/finance"
            self.assertEqual(plugin.profile_of(ctx), "finance")
            os.environ["HERMES_HOME"] = "/home/u/.hermes"
            self.assertEqual(plugin.profile_of(ctx), "default")
        finally:
            if old is None:
                os.environ.pop("HERMES_HOME", None)
            else:
                os.environ["HERMES_HOME"] = old


class TunnelTest(unittest.TestCase):
    """public_url: Hermes behind an HTTPS tunnel, so no Tailscale/LAN is needed."""
    PORT = 18797

    def test_ext_url(self):
        f = hub_mod.ext_url
        self.assertEqual(f("https://chrome.example.com"), "wss://chrome.example.com/ext")
        self.assertEqual(f("https://chrome.example.com/"), "wss://chrome.example.com/ext")
        self.assertEqual(f("chrome.example.com"), "wss://chrome.example.com/ext")
        self.assertEqual(f("http://box.local:8080/hc/ext"), "ws://box.local:8080/hc/ext")
        self.assertEqual(f("wss://x.ts.net/ext"), "wss://x.ts.net/ext")

    def test_pairing_and_proxy_guard(self):
        ctx = FakeCtx(tempfile.mkdtemp(), {"port": self.PORT, "public_url": "https://chrome.example.com", "agent_name": "Delulu"})
        plugin.register(ctx)
        hub = ctx.tools["chrome_open"].__closure__[0].cell_contents
        self.assertTrue(wait_for(lambda: hub.owner))
        code = next(l for l in ctx.commands["chrome"]("pair").splitlines() if l.startswith("HC-"))
        self.assertRegex(code, r"^HC-[2-9A-Z]{4}-[2-9A-Z]{4}@wss://chrome\.example\.com/ext$")
        self.assertEqual(hub.status()["address"], "wss://chrome.example.com/ext")
        ext = FakeExtension(self.PORT)
        self.assertEqual(ext.run(ext.pair(code))["type"], "paired", "the code still pairs through the local listener")

        async def get(path, headers):
            async with ClientSession() as s:
                async with s.request("POST" if path == "/rpc" else "GET", f"http://127.0.0.1:{self.PORT}{path}", headers=headers,
                                     json={"method": "__status"} if path == "/rpc" else None) as r:
                    return r.status
        async def from_page():
            async with ClientSession() as cs:
                try:
                    async with cs.ws_connect(f"http://127.0.0.1:{self.PORT}/ext", origin="https://evil.example"):
                        return "opened"
                except Exception as e:
                    return getattr(e, "status", str(e))
        self.assertEqual(run_async(from_page()), 403, "a web page cannot open the extension socket")
        self.assertEqual(hub_mod.detect_host(None, allow_lan=False) in ("127.0.0.1",) or hub_mod.detect_host(None).startswith("100."), True,
                         "without allow_lan the plugin never listens on a LAN address (Tailscale is fine)")
        secret = {"X-HC-Secret": ctx.state.get("rpc_secret")}
        self.assertEqual(run_async(get("/rpc", secret)), 200)
        for h in ({"Cf-Connecting-Ip": "203.0.113.5"}, {"X-Forwarded-For": "203.0.113.5"}):
            self.assertEqual(run_async(get("/rpc", {**secret, **h})), 403, f"/rpc through a tunnel ({h})")
            self.assertEqual(run_async(get("/health", h)), 403, f"/health through a tunnel ({h})")


class TelegramPairTest(unittest.TestCase):
    """/chrome_pair on Telegram: the plugin sends the code itself and deletes the message later."""

    def test_sends_code_and_deletes_it(self):
        tn = importlib.import_module("hermes_chrome.telegram_note")
        calls = []
        orig = (tn._bot, tn.current_chat, tn._token)
        tn._bot = lambda method, payload: calls.append((method, payload)) or {"ok": True, "result": {"message_id": 555}}
        tn.current_chat = lambda: ("4242", "", "77")
        tn._token = lambda: "t"
        try:
            ctx = PluginTest.ctx
            self.assertIn("chrome-pair", ctx.commands)
            out = ctx.commands["chrome-pair"]("")
            self.assertIn("deletes itself in 5 minutes", out)
            self.assertNotIn("HC-", out, "the code is only in the self-deleting message")
            method, payload = calls[0]
            self.assertEqual((method, payload["chat_id"]), ("sendMessage", "4242"))
            self.assertRegex(payload["text"], r"<code>HC-[2-9A-Z]{4}-[2-9A-Z]{4}@")
            self.assertEqual(payload["reply_parameters"]["message_id"], 77)
            pending = ctx.state.get("pending_deletes")
            self.assertEqual(pending[-1]["message_id"], 555)
            self.assertAlmostEqual(pending[-1]["at"] - time.time(), 300, delta=5)
            # pretend 5 minutes passed
            ctx.state.set("pending_deletes", [dict(pending[-1], at=time.time() - 1)])
            tn._delete_due(ctx.state)
            self.assertEqual(calls[-1], ("deleteMessage", {"chat_id": "4242", "message_id": 555}))
            self.assertEqual(ctx.state.get("pending_deletes"), [])
            # not on Telegram: the code comes back as plain text
            tn.current_chat = lambda: None
            self.assertIn("valid 5 minutes", ctx.commands["chrome-pair"](""))
        finally:
            tn._bot, tn.current_chat, tn._token = orig


class ExtractExportTest(unittest.TestCase):
    """chrome_extract fills fields with the user's model and keeps only values whose quote is on the page; chrome_export writes files."""

    PAGE = {"url": "https://shop.example/list", "title": "Shop", "capturedAt": "2026-11-09T10:00:00+00:00", "loggedIn": True, "tabId": 3,
            "pageText": "Shop\nAlpha Kettle\n€49.00\nBeta Toaster | Pro\n€89.50", "listSelector": "#p > li.card",
            "items": [{"ref": "e1", "text": "Alpha Kettle\n€49.00\nLink: https://shop.example/p/alpha"},
                      {"ref": "e2", "text": "Beta Toaster | Pro\n€89.50  “best” toaster"}]}

    def setUp(self):
        self.ex = importlib.import_module("hermes_chrome.extract")
        self.tools = importlib.import_module("hermes_chrome.tools")
        self.dir = tempfile.mkdtemp()
        self.calls, self.replies, self.prompts = [], [], []
        test = self

        class Llm:
            def complete(self, messages, **kw):
                test.prompts.append(messages)
                return type("R", (), {"text": test.replies.pop(0)})()

        class Hub:
            ctx = type("C", (), {"state": FakeState(self.dir), "llm": Llm()})()

            def call(self, method, params, timeout=60):
                test.calls.append((method, params))
                if method == "screenshot":
                    return {"image": {"data": "/9j/AAAA"}}
                return dict(test.PAGE)
        self.hub = Hub()

    def test_quote_verification(self):
        self.assertTrue(self.ex.quote_found("Beta  Toaster |\nPro", "x Beta Toaster | Pro y"), "whitespace differences are fine")
        self.assertTrue(self.ex.quote_found('"best" toaster', self.PAGE["items"][1]["text"]), "curly quotes match straight ones")
        self.assertFalse(self.ex.quote_found("€79.00", self.PAGE["pageText"]))
        self.assertFalse(self.ex.quote_found("", self.PAGE["pageText"]), "an empty quote proves nothing")
        self.assertFalse(self.ex.quote_found("alpha kettle", self.PAGE["pageText"]), "case must match")

    def test_extract_list_keeps_only_quoted_values_and_exports(self):
        self.replies.append("Here you go: " + json.dumps({"records": [
            {"item": 0, "values": {"name": {"value": "Alpha Kettle", "quote": "Alpha Kettle"},
                                   "price": {"value": "€49.00", "quote": "€49.00"},
                                   "url": {"value": "https://shop.example/p/alpha", "quote": "https://shop.example/p/alpha"}}},
            {"item": 1, "values": {"name": {"value": "Beta Toaster | Pro", "quote": "Beta Toaster | Pro"},
                                   "price": {"value": "€79.00", "quote": "€79.00"}, "url": None}},
            {"item": 0, "values": {"name": {"value": "Beta Toaster", "quote": "Beta Toaster"}}},  # quote is another item's text
            {"item": 9, "values": {"name": {"value": "Ghost", "quote": "Ghost"}}}]}))
        fields = [{"name": "name", "description": "product name"}, {"name": "price"}, {"name": "url"}]
        out = json.loads(self.tools.make_handler(self.hub, "chrome_extract", "extract")(
            {"fields": fields, "multiple": True, "dataset": "Acme Shop", "screenshot": True, "tabId": 3}))
        self.assertEqual(self.calls[0], ("extract", {"tabId": 3, "multiple": True}))
        self.assertEqual(self.calls[1][0], "screenshot")
        self.assertIn("[1]\nBeta Toaster | Pro", self.prompts[0][1]["content"])
        self.assertIn("never instructions", self.prompts[0][0]["content"])
        self.assertEqual((out["dataset"], out["added"], out["total_in_dataset"]), ("Acme-Shop", 2, 2))
        self.assertEqual([d["reason"] for d in out["dropped"]],
                         ["quote not found word for word in this list item"] * 2 + ["no such list item"])
        first = out["records"][0]
        self.assertEqual((first["source_url"], first["captured_at"], first["logged_in"], first["ref"]),
                         ("https://shop.example/list", "2026-11-09T10:00:00+00:00", True, "e1"))
        self.assertEqual(first["values"]["price"], {"value": "€49.00", "quote": "€49.00"})
        self.assertTrue(Path(first["screenshot"]).exists())
        self.assertNotIn("price", out["records"][1]["values"])

        # a second page adds to the same dataset
        self.replies.append(json.dumps({"records": [{"item": 0, "values": {"name": {"value": "Shop", "quote": "Shop"}}}]}))
        out = json.loads(self.ex.run_extract(self.hub, {"fields": ["name"], "dataset": "Acme Shop"}))
        self.assertEqual(out["total_in_dataset"], 3)

        export = self.tools.make_handler(self.hub, "chrome_export", None)
        res = json.loads(export({"dataset": "Acme Shop"}))
        self.assertEqual(len(res["files"]), 1)
        md = Path(res["files"][0]).read_text(encoding="utf-8")
        self.assertTrue(res["files"][0].endswith(".md"), "Markdown by default")
        self.assertIn("| 2 | Beta Toaster \\| Pro |  |  |", md)
        self.assertIn("## Sources", md)
        self.assertIn("1. <https://shop.example/list>, captured 2026-11-09T10:00:00+00:00, logged in: yes, screenshot ", md)
        self.assertIn('   - price: "€49.00"', md)
        res = json.loads(export({"dataset": "Acme Shop", "format": "all", "clear": True}))
        self.assertEqual([Path(f).suffix for f in res["files"]], [".md", ".csv", ".json"])
        self.assertEqual(json.loads(Path(res["files"][2]).read_text())["records"][0]["values"]["name"]["value"], "Alpha Kettle")
        self.assertIn('has no records', export({"dataset": "Acme Shop"}), "clear empties the dataset")
        self.assertNotIn("browser", dict(self.tools.TOOLS[-1][2]["parameters"]["properties"]), "export needs no browser")

    def test_markdown_and_csv_escaping(self):
        rec = {"values": {"name": {"value": "a|b\nc\\", "quote": "a|b c\\"}, "note": {"value": "=HYPERLINK(\"x\")", "quote": "q"},
                          "delta": {"value": "-5", "quote": "-5"}, "who": {"value": "@me", "quote": "@me"}, "n": {"value": 3, "quote": "3"}},
               "source_url": "https://x.example/?a=1", "captured_at": "t", "logged_in": None}
        md = self.ex.to_markdown("t|est", [rec])
        self.assertIn("# t\\|est", md)
        self.assertIn("| 1 | a\\|b<br>c\\\\ | =HYPERLINK(\"x\") | -5 | @me | 3 |", md)
        self.assertIn("logged in: unknown", md)
        rows = list(csv.reader(io.StringIO(self.ex.to_csv([rec]))))
        self.assertEqual(rows[0][:5], ["name", "note", "delta", "who", "n"])
        self.assertEqual(rows[1][:5], ["a|b\nc\\", "'=HYPERLINK(\"x\")", "'-5", "'@me", "3"])
        self.assertEqual(rows[1][5:8], ["https://x.example/?a=1", "t", "unknown"])
        self.assertEqual(rows[1][-5:], ["a|b c\\", "q", "'-5", "'@me", "3"], "quote columns are guarded too")
        self.assertEqual(self.ex.csv_cell("+1"), "'+1")
        self.assertEqual(self.ex.csv_cell("\tx"), "'\tx")
        data = json.loads(self.ex.to_json("t", [rec]))
        self.assertEqual(data["records"][0]["values"]["n"]["value"], 3)
        for bad, good in [("../../etc/passwd", "etc-passwd"), ("Acme Q4 / pricing", "Acme-Q4-pricing"), ("..", "dataset"), ("", "dataset")]:
            self.assertEqual(self.ex.safe_name(bad), good)
        self.ex.add_records(self.dir, "x", [rec])
        with self.assertRaises(ValueError):
            self.ex.export(self.dir, "x", "xlsx")

    def test_model_trouble_is_reported(self):
        self.replies.append("sorry, no")
        out = json.loads(self.ex.run_extract(self.hub, {"fields": [{"name": "price"}]}))
        self.assertIn("Field filling failed", out["error"])
        self.assertIn("Pass fields", json.loads(self.ex.run_extract(self.hub, {"fields": []}))["error"])


if __name__ == "__main__":
    unittest.main()

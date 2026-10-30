"""Plugin tests without Hermes: a fake plugin context, a fake extension (WebSocket) and a mock API server.

Run with any Python that has aiohttp (Hermes' venv has it):
  python -m unittest discover -s tests
"""
import asyncio
import importlib
import importlib.util
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
            if data.get("type") in ("chat_event", "chat_meta", "skill_saved", "recordings", "recording_run"):
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
        self.assertEqual(len(self.ctx.tools), 19)
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


if __name__ == "__main__":
    unittest.main()

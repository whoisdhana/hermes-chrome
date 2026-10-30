"""Connection hub for one Hermes profile.

The first process that binds the port (normally the gateway) becomes the *owner*: it holds the
extension's WebSocket and serves pairing, tool calls and side-panel chat. Any other Hermes process
(the CLI, a cron worker) is a *client*: it forwards calls to the owner over a loopback RPC endpoint
guarded by a per-profile secret. Clients keep trying to bind, so they take over if the owner exits.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import secrets
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request

from aiohttp import WSMsgType, web

from . import chat, recordings

log = logging.getLogger("hermes_chrome")

CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"  # no 0/O, 1/I/L
CODE_TTL = 300
MAX_PAIR_FAILURES = 5
MAX_MESSAGE = 40 * 1024 * 1024


class BrowserUnavailable(Exception):
    pass


def detect_host(override: str | None) -> str:
    """Address the extension should dial: explicit setting, else Tailscale, else primary LAN IP."""
    if override:
        return override
    try:
        out = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=3)
        ip = out.stdout.split()[0] if out.returncode == 0 and out.stdout.strip() else ""
        if ip:
            return ip
    except Exception:
        pass
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))  # no packet is sent; just picks the outbound interface
            return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"


def _hash(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def normalize_code(raw: str) -> str:
    code = (raw or "").split("@", 1)[0].upper().replace(" ", "").replace("-", "")
    return code[2:] if code.startswith("HC") else code


class Hub:
    def __init__(self, ctx, *, port: int, advertise_host: str | None, offline_message: str, agent_name: str):
        self.ctx = ctx
        self.port = port
        self.advertise_override = advertise_host
        self.offline_message = offline_message
        self.agent_name = agent_name
        self.profile = ctx.profile_name
        self.loop: asyncio.AbstractEventLoop | None = None
        self.owner = False
        self.advertise = "127.0.0.1"
        # Every paired browser can be connected at once: device id -> {ws, info}.
        self.conns: dict[str, dict] = {}
        self.current: str | None = None  # default browser: the one the agent (or a side-panel chat) used last
        self.pending: dict[int, tuple[asyncio.Future, str]] = {}
        self.seq = 0
        self.codes: dict[str, float] = {}
        self.pair_failures = 0
        self.chats: dict[str, asyncio.Task] = {}
        self.ready = threading.Event()  # set once the first bind attempt has finished

    # ------------------------------------------------------------------ lifecycle
    def start(self) -> None:
        threading.Thread(target=self._run, name="hermes-chrome-hub", daemon=True).start()

    def _run(self) -> None:
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        self.loop.run_until_complete(self._serve_forever())

    async def _serve_forever(self) -> None:
        while True:
            if not self.owner:
                try:
                    await self._bind()
                except OSError:
                    pass  # another process owns the port; try again later
                except Exception:
                    log.exception("hermes-chrome: failed to start listener")
            self.ready.set()
            await asyncio.sleep(10)

    async def _bind(self) -> None:
        app = web.Application(client_max_size=MAX_MESSAGE)
        app.router.add_get("/health", self._health)
        app.router.add_get("/ext", self._ext)
        app.router.add_post("/rpc", self._rpc_handler)
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        try:
            await web.TCPSite(runner, "127.0.0.1", self.port).start()
        except OSError:
            await runner.cleanup()
            raise
        self.owner = True
        self._secret()  # make sure clients can find it
        self.advertise = detect_host(self.advertise_override)
        if self.advertise != "127.0.0.1":
            try:
                await web.TCPSite(runner, self.advertise, self.port).start()
            except OSError as e:
                log.warning("hermes-chrome: could not listen on %s:%s (%s); loopback only", self.advertise, self.port, e)
                self.advertise = "127.0.0.1"
        log.info("hermes-chrome: listening for the browser on %s:%s (profile %s)", self.advertise, self.port, self.profile)

    # ------------------------------------------------------------------ state
    def _secret(self) -> str:
        s = self.ctx.state.get("rpc_secret")
        if not s:
            s = secrets.token_hex(24)
            self.ctx.state.set("rpc_secret", s)
        return s

    def _devices(self) -> dict:
        return dict(self.ctx.state.get("devices", default={}) or {})

    def _save_devices(self, devices: dict) -> None:
        self.ctx.state.set("devices", devices)

    # ------------------------------------------------------------------ pairing (owner side)
    def _new_code(self) -> str:
        now = time.time()
        self.codes = {c: exp for c, exp in self.codes.items() if exp > now}
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
        self.codes[code] = now + CODE_TTL
        self.pair_failures = 0
        return f"HC-{code[:4]}-{code[4:]}@{self.advertise}:{self.port}"

    def _redeem(self, raw: str, device_name: str) -> dict | None:
        code = normalize_code(raw)
        exp = self.codes.pop(code, None)
        if not exp or exp < time.time():
            self.pair_failures += 1
            if self.pair_failures >= MAX_PAIR_FAILURES:
                self.codes.clear()  # too many wrong guesses: every outstanding code dies
            return None
        device_id = secrets.token_hex(6)
        key = secrets.token_urlsafe(32)
        devices = self._devices()
        devices[device_id] = {"name": (device_name or "Chrome")[:60], "key_sha256": _hash(key),
                              "created": int(time.time()), "last_seen": int(time.time())}
        self._save_devices(devices)
        return {"deviceId": device_id, "deviceKey": key}

    def _check_device(self, device_id: str, key: str) -> bool:
        dev = self._devices().get(device_id or "")
        return bool(dev) and hmac.compare_digest(dev["key_sha256"], _hash(key or ""))

    def _touch(self, device_id: str, name: str | None = None) -> None:
        """Record a connect; the extension's current device name wins, so renames show up here."""
        devices = self._devices()
        if device_id in devices:
            devices[device_id]["last_seen"] = int(time.time())
            if name and name.strip():
                devices[device_id]["name"] = name.strip()[:60]
            self._save_devices(devices)

    def _revoke(self, who: str) -> list[str]:
        devices = self._devices()
        gone = [d for d, v in devices.items() if who in (d, v["name"]) or who == "all"]
        for d in gone:
            devices.pop(d)
        self._save_devices(devices)
        for d in gone:
            if d in self.conns:
                asyncio.ensure_future(self.conns[d]["ws"].close(code=4001, message=b"revoked"))
        return gone

    # ------------------------------------------------------------------ HTTP handlers (owner)
    async def _health(self, request):
        return web.json_response({"ok": True, "profile": self.profile, "extension": self.connected})

    async def _ext(self, request):
        ws = web.WebSocketResponse(heartbeat=30, max_msg_size=MAX_MESSAGE)
        await ws.prepare(request)
        try:
            first = await asyncio.wait_for(ws.receive(), 5)
            msg = json.loads(first.data) if first.type == WSMsgType.TEXT else {}
        except Exception:
            msg = {}
        if msg.get("type") == "pair":
            res = self._redeem(msg.get("code", ""), msg.get("deviceName", ""))
            if res:
                await ws.send_json({"type": "paired", **res, "agentName": self.agent_name})
                log.info("hermes-chrome: paired a new browser (%s)", msg.get("deviceName"))
            else:
                await ws.send_json({"type": "pair_failed", "reason": "Code is wrong or expired. Run /chrome pair again."})
            await ws.close(code=1000)
            return ws
        if msg.get("type") != "hello" or not self._check_device(msg.get("deviceId"), msg.get("deviceKey")):
            await ws.close(code=4001, message=b"unauthorized")
            return ws

        did = msg["deviceId"]
        if did in self.conns:  # the same browser reconnecting: its new socket wins; other browsers are untouched
            await self.conns[did]["ws"].close(code=4000, message=b"replaced by a newer connection")
        self.conns[did] = {"ws": ws, "info": {"browser": msg.get("browser"), "version": msg.get("version")}}
        self._touch(did, msg.get("deviceName"))
        if self.current not in self.conns:
            self.current = did
        log.info("hermes-chrome: browser connected: %s (%s %s)", self._name(did), msg.get("browser"), msg.get("version"))
        await ws.send_json({"type": "welcome", "agentName": self.agent_name, "profile": self.profile})
        try:
            async for m in ws:
                if m.type != WSMsgType.TEXT:
                    continue
                try:
                    data = json.loads(m.data)
                except ValueError:
                    continue
                kind = data.get("type")
                if kind == "ping":
                    await ws.send_json({"type": "pong"})
                elif kind == "chat":
                    self.current = did  # a side-panel chat works in the browser it came from
                    task = asyncio.ensure_future(chat.run(self, ws, data))
                    task.hc_device = did
                    self.chats[data["chatId"]] = task
                elif kind == "chat_cancel":
                    task = self.chats.get(data.get("chatId"))
                    if task:
                        task.cancel()
                elif kind == "chat_meta":
                    asyncio.ensure_future(chat.meta(self, ws))
                elif kind == "list_recordings":
                    await ws.send_json({"type": "recordings", "items": recordings.list_all()})
                elif kind == "delete_recording":
                    recordings.delete(data.get("name", ""))
                    await ws.send_json({"type": "recordings", "items": recordings.list_all()})
                elif kind == "run_recording":  # own task: the replay's tool calls come back over this same socket
                    asyncio.ensure_future(self._run_recording(ws, did, data))
                elif kind == "save_skill":
                    try:
                        folder = recordings.save(data.get("name", ""), data.get("description", ""), data.get("steps"))
                        await ws.send_json({"type": "skill_saved", "id": data.get("id"), "ok": True, "name": folder.name, "path": str(folder)})
                        log.info("hermes-chrome: saved recorded workflow %s", folder.name)
                    except Exception as e:
                        await ws.send_json({"type": "skill_saved", "id": data.get("id"), "ok": False, "error": str(e)})
                elif "id" in data:
                    fut, _ = self.pending.pop(data["id"], (None, None))
                    if fut and not fut.done():
                        if data.get("error"):
                            fut.set_exception(RuntimeError(data["error"]))
                        else:
                            fut.set_result(data.get("result"))
        finally:
            if self.conns.get(did, {}).get("ws") is ws:
                del self.conns[did]
                log.info("hermes-chrome: browser disconnected: %s", self._name(did))
                for seq, (fut, dev) in list(self.pending.items()):
                    if dev == did:
                        self.pending.pop(seq)
                        if not fut.done():
                            fut.set_exception(BrowserUnavailable(f'{self.offline_message} ("{self._name(did)}" disconnected)'))
                for task in list(self.chats.values()):  # its chat turns have nowhere to stream to
                    if getattr(task, "hc_device", None) == did:
                        task.cancel()
                if self.current == did:
                    self.current = next(iter(self.conns), None)
        return ws

    async def _run_recording(self, ws, did: str, data: dict) -> None:
        """Side panel ▶ Run: replay a saved workflow in the browser that asked."""
        reply = {"type": "recording_run", "id": data.get("id"), "name": data.get("name")}
        rec = recordings.load(data.get("name", ""))
        if not rec:
            await ws.send_json({**reply, "ok": False, "error": "That recording no longer exists."})
            return
        steps, missing = recordings.fill(rec["steps"], data.get("vars") or {})
        if missing:
            await ws.send_json({**reply, "ok": False, "missing": missing})
            return
        try:
            res = await self._call("replay", {"name": rec["name"], "steps": steps, "browser": self._name(did)}, 120 + 45 * len(steps))
            await ws.send_json({**reply, "ok": True, "text": (res or {}).get("text", "Done.")})
        except Exception as e:
            if not ws.closed:
                await ws.send_json({**reply, "ok": False, "error": str(e)})

    async def _rpc_handler(self, request):
        if request.remote not in ("127.0.0.1", "::1"):
            return web.Response(status=403)
        if not hmac.compare_digest(request.headers.get("X-HC-Secret", ""), self._secret()):
            return web.Response(status=401)
        body = await request.json()
        method, params = body.get("method"), body.get("params") or {}
        try:
            if method == "__status":
                result = self.status()
            elif method == "__pair":
                result = self._new_code()
            elif method == "__revoke":
                result = self._revoke(params.get("who", ""))
            else:
                result = await self._call(method, params, float(body.get("timeout", 60)))
            return web.json_response({"result": result})
        except BrowserUnavailable as e:
            return web.json_response({"unavailable": str(e)})
        except Exception as e:
            return web.json_response({"error": str(e)})

    # ------------------------------------------------------------------ calls
    @property
    def connected(self) -> bool:
        return any(not c["ws"].closed for c in self.conns.values())

    def _name(self, did: str | None) -> str:
        return self._devices().get(did or "", {}).get("name") or (did or "")

    def _pick(self, browser: str | None) -> str:
        """Device id for a call: the named browser, else the current default, else any connected one."""
        live = {d: self._name(d) for d, c in self.conns.items() if not c["ws"].closed}
        if not live:
            raise BrowserUnavailable(self.offline_message)
        if browser:
            want = browser.strip().casefold()
            exact = [d for d, n in live.items() if n.casefold() == want or d == browser]
            partial = [d for d, n in live.items() if want in n.casefold()]
            if exact or len(partial) == 1:
                return (exact or partial)[0]
            raise RuntimeError(f'No connected browser called "{browser}". Connected: {", ".join(live.values())}.')
        return self.current if self.current in live else next(iter(live))

    async def _call(self, method: str, params: dict, timeout: float):
        params = dict(params)
        did = self._pick(params.pop("browser", None))
        self.current = did
        self.seq += 1
        seq = self.seq
        fut = self.loop.create_future()
        self.pending[seq] = (fut, did)
        await self.conns[did]["ws"].send_json({"id": seq, "method": method, "params": params})
        try:
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            self.pending.pop(seq, None)
            raise RuntimeError(f"{method} timed out after {int(timeout)} s")

    def _rpc(self, payload: dict, timeout: float):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/rpc", data=json.dumps(payload).encode(), method="POST",
            headers={"content-type": "application/json", "X-HC-Secret": self._secret()})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = json.loads(r.read())
        except (urllib.error.URLError, OSError):
            raise BrowserUnavailable(self.offline_message)
        if "unavailable" in body:
            raise BrowserUnavailable(body["unavailable"])
        if "error" in body:
            raise RuntimeError(body["error"])
        return body["result"]

    def call(self, method: str, params: dict, timeout: float = 60):
        """Blocking call from a tool handler thread, in either the owner or a client process."""
        self.ready.wait(5)
        if self.owner and self.loop:
            return asyncio.run_coroutine_threadsafe(self._call(method, params, timeout), self.loop).result(timeout + 5)
        return self._rpc({"method": method, "params": params, "timeout": timeout}, timeout + 5)

    def status(self) -> dict:
        self.ready.wait(5)
        if self.owner:
            browsers = [{"name": self._name(d), "id": d, "chrome": c["info"].get("browser"), "default": d == self.current}
                        for d, c in self.conns.items() if not c["ws"].closed]
            current = self._name(self.current) if self.current in self.conns else None
            return {"connected": bool(browsers), "device": current, "browsers": browsers, "address": f"{self.advertise}:{self.port}",
                    "devices": [{"id": d, "name": v["name"], "last_seen": v["last_seen"]} for d, v in self._devices().items()]}
        try:
            return self._rpc({"method": "__status"}, 2)
        except Exception:
            return {"connected": False, "devices": []}

    def pair_code(self) -> str:
        self.ready.wait(5)
        if self.owner:
            return asyncio.run_coroutine_threadsafe(self._async(self._new_code), self.loop).result(5)
        return self._rpc({"method": "__pair"}, 5)

    def revoke(self, who: str) -> list[str]:
        self.ready.wait(5)
        if self.owner:
            return asyncio.run_coroutine_threadsafe(self._async(self._revoke, who), self.loop).result(5)
        return self._rpc({"method": "__revoke", "params": {"who": who}}, 5)

    @staticmethod
    async def _async(fn, *args):
        return fn(*args)

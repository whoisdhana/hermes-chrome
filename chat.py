"""Side-panel chat: relays turns to this profile's own Hermes API server and streams events back.

Runs on the hub's event loop (owner process). Images go to the model natively (input_image);
other files are saved under the plugin's data dir and the agent is told where they are.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import time
from pathlib import Path

from aiohttp import ClientSession, ClientTimeout

NO_API = ("Side-panel chat needs this profile's Hermes API server: set API_SERVER_ENABLED=true and an API_SERVER_KEY "
          "for this profile (see the README, Side-panel chat), then restart the gateway.")
MAX_FILE = 25 * 1024 * 1024


def _hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")


def _secret(name: str) -> str:
    """A value through Hermes' profile-scoped secret route (catalog rule 11: never from .env or other files). "" when
    unset, or when Hermes cannot tell which profile is asking (multiplexed gateway without a scope)."""
    try:
        from agent.secret_scope import get_secret
        return (get_secret(name) or "").strip()
    except Exception:
        return ""


def api_target() -> tuple[str, str]:
    """(base URL, key) of this profile's API server. Host and port are Hermes' own listener settings (default
    127.0.0.1:8642); the key comes from Hermes' secret route."""
    host = _secret("API_SERVER_HOST") or "127.0.0.1"
    if host in ("0.0.0.0", "::"):
        host = "127.0.0.1"
    port = _secret("API_SERVER_PORT") or "8642"
    return f"http://{host}:{port}", _secret("API_SERVER_KEY")


def _save_upload(hub, f: dict) -> str | None:
    data = base64.b64decode(f.get("data") or "", validate=False)
    if not data or len(data) > MAX_FILE:
        return None
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", f.get("name") or "file")[-80:]
    folder = Path(hub.ctx.state.data_dir) / "uploads"
    folder.mkdir(parents=True, exist_ok=True)
    for old in folder.iterdir():  # side-panel attachments are for the chat at hand; keep a week, no more
        try:
            if old.is_file() and time.time() - old.stat().st_mtime > 7 * 86400:
                old.unlink()
        except OSError:
            pass
    path = folder / f"{time.strftime('%Y%m%d-%H%M%S')}-{name}"
    path.write_bytes(data)
    return str(path)


async def run(hub, ws, msg: dict) -> None:
    chat_id = msg["chatId"]

    async def send(kind: str, **data):
        if not ws.closed:
            await ws.send_json({"type": "chat_event", "chatId": chat_id, "kind": kind, **data})

    base, key = api_target()
    if not key:
        await send("error", message=NO_API)
        return

    text = msg.get("text") or ""
    saved = [p for p in (_save_upload(hub, f) for f in msg.get("files") or []) if p]
    if saved:
        text += "\n\n[Files the user attached are saved on this machine: " + "; ".join(saved) + ". Read them with your file tools.]"
    images = [u for u in msg.get("images") or [] if isinstance(u, str) and u.startswith("data:image/")]
    content = text if not images else [{"role": "user", "content": [{"type": "input_text", "text": text}]
                                         + [{"type": "input_image", "image_url": u} for u in images]}]
    body = {"model": "hermes-agent", "input": content, "conversation": msg.get("conversation"), "stream": True, "store": True}
    if msg.get("model") and msg.get("provider"):
        body.update(model=msg["model"], provider=msg["provider"])

    commentary: set[str] = set()
    try:
        async with ClientSession(timeout=ClientTimeout(total=None, sock_read=900)) as s:
            async with s.post(f"{base}/v1/responses", json=body, headers={"authorization": f"Bearer {key}"}) as r:
                if r.status != 200:
                    detail = (await r.text())[:300]
                    reason = "the API_SERVER_KEY was rejected" if r.status in (401, 403) else detail
                    await send("error", message=f"Hermes API {r.status}: {reason}")
                    return
                buf = ""
                async for chunk in r.content.iter_any():
                    buf += chunk.decode("utf-8", "replace").replace("\r\n", "\n")
                    while "\n\n" in buf:
                        block, buf = buf.split("\n\n", 1)
                        data = "\n".join(l[5:].strip() for l in block.split("\n") if l.startswith("data:"))
                        if not data or data == "[DONE]":
                            continue
                        try:
                            ev = json.loads(data)
                        except ValueError:
                            continue
                        await _forward(ev, send, commentary)
        await send("done")
    except asyncio.CancelledError:
        await send("stopped")
    except Exception as e:
        await send("error", message=f"Could not reach the Hermes API server ({e}). {NO_API}")
    finally:
        hub.chats.pop(chat_id, None)


async def _forward(ev: dict, send, commentary: set) -> None:
    t, item = ev.get("type"), ev.get("item") or {}
    if t == "response.output_item.added" and item.get("type") == "message" and item.get("phase") == "commentary":
        commentary.add(item.get("id"))
    elif t == "response.output_text.delta" and ev.get("item_id") not in commentary:
        await send("delta", text=ev.get("delta", ""))
    elif t == "response.output_item.done" and item.get("type") == "function_call":
        await send("tool", name=item.get("name"), args=item.get("arguments"))
    elif t == "response.output_item.done" and item.get("type") == "message" and item.get("id") in commentary:
        await send("commentary", text="".join(c.get("text", "") for c in item.get("content") or []))
    elif t in ("response.failed", "error"):
        err = (ev.get("response") or {}).get("error") or ev.get("error") or {}
        text = err.get("message") if isinstance(err, dict) else str(err)
        await send("error", message=text or "Hermes reported an error")


def _skills() -> list[dict]:
    """Skills from the profile's skills/ folder (name + description from SKILL.md front matter)."""
    out, root = [], _hermes_home() / "skills"
    for md in sorted(root.glob("**/SKILL.md")) if root.is_dir() else []:
        if len(md.relative_to(root).parts) > 4:
            continue
        meta = {}
        try:
            text = md.read_text(errors="replace")
        except OSError:
            continue
        if text.startswith("---"):
            for line in text.split("---", 2)[1].splitlines():
                if ":" in line and not line.startswith(" "):
                    k, v = line.split(":", 1)
                    meta[k.strip()] = v.strip().strip("'\"")
        name = meta.get("name") or md.parent.name
        out.append({"name": name, "description": meta.get("description", "")[:140]})
    return out[:400]


async def meta(hub, ws) -> None:
    """Models the user can pick (signed-in providers only) and the profile's skills, for the panel's menus."""
    base, key = api_target()
    models = {"current": None, "providers": []}
    if key:
        try:
            async with ClientSession(timeout=ClientTimeout(total=15)) as s:
                async with s.get(f"{base}/api/model/options", headers={"authorization": f"Bearer {key}"}) as r:
                    if r.status == 200:
                        d = await r.json()
                        models["current"] = {"model": d.get("model"), "provider": d.get("provider")}
                        models["providers"] = [{"slug": p["slug"], "name": p.get("name", p["slug"]), "models": p["models"]}
                                               for p in d.get("providers", []) if p.get("authenticated") and p.get("models")]
        except Exception:
            pass
    skills = await asyncio.get_running_loop().run_in_executor(None, _skills)
    if not ws.closed:
        await ws.send_json({"type": "chat_meta", "chatAvailable": bool(key), "models": models, "skills": skills})

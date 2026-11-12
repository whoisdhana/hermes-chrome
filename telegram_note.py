"""Telegram delivery for pairing codes: send through the profile's own bot, delete after the code expires.

Hermes' plugin API cannot delete messages, so the plugin talks to the Bot API directly with the
profile's TELEGRAM_BOT_TOKEN. Pending deletions are kept in plugin state so a gateway restart
inside the window still cleans up.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.request
import uuid

from .chat import _env, _hermes_home, _routed, bound

log = logging.getLogger("hermes_chrome")


def _in_profile(fn):
    """fn for a timer thread: pinned to this profile's home when a shared gateway serves it (threads do not inherit it)."""
    return bound(_hermes_home(), fn) if _routed() else fn


def _token() -> str:
    return _env("TELEGRAM_BOT_TOKEN")


def _bot(method: str, payload: dict) -> dict:
    req = urllib.request.Request(f"https://api.telegram.org/bot{_token()}/{method}", data=json.dumps(payload).encode(),
                                 headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def current_chat() -> tuple[str, str, str] | None:
    """(chat_id, thread_id, message_id) when the command came from Telegram, else None."""
    try:
        from gateway.session_context import get_session_env
    except Exception:
        return None
    if get_session_env("HERMES_SESSION_PLATFORM") != "telegram" or not _token():
        return None
    chat = get_session_env("HERMES_SESSION_CHAT_ID")
    return (chat, get_session_env("HERMES_SESSION_THREAD_ID"), get_session_env("HERMES_SESSION_MESSAGE_ID")) if chat else None


def send_code(state, where: tuple[str, str, str], code: str, ttl: int) -> bool:
    chat_id, thread_id, reply_to = where
    text = (f"🔗 <b>Hermes Chrome pairing code</b>\n\n<code>{code}</code>\n\n"
            "Tap the code to copy it, then right-click the Hermes Chrome icon → Settings → Pair.\n"
            f"Works once. This message deletes itself in {ttl // 60} minutes.")
    payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
    if thread_id:
        payload["message_thread_id"] = int(thread_id)
    if reply_to:
        payload["reply_parameters"] = {"message_id": int(reply_to), "allow_sending_without_reply": True}
    try:
        res = _bot("sendMessage", payload)
    except Exception as e:
        log.warning("hermes-chrome: could not send pairing code via Telegram: %s", e)
        return False
    if not res.get("ok"):
        log.warning("hermes-chrome: Telegram refused the pairing message: %s", res.get("description"))
        return False
    schedule_delete(state, chat_id, res["result"]["message_id"], time.time() + ttl)
    return True


def notify(text: str) -> bool:
    """Plain message to the Telegram chat the current turn came from (no-op elsewhere)."""
    where = current_chat()
    if not where:
        return False
    payload = {"chat_id": where[0], "text": text}
    if where[1]:
        payload["message_thread_id"] = int(where[1])
    try:
        return bool(_bot("sendMessage", payload).get("ok"))
    except Exception as e:
        log.info("hermes-chrome: Telegram notify failed: %s", e)
        return False


def send_report(text: str, shots: list[tuple[bytes, str]]) -> bool:
    """Summary plus up to 3 snapshots as one album, to the current Telegram chat."""
    where = current_chat()
    if not where:
        return False
    if not shots:
        return notify(text)
    fields = {"chat_id": where[0], "media": json.dumps([
        {"type": "photo", "media": f"attach://p{i}", **({"caption": text} if i == 0 else {})} for i in range(len(shots[:3]))])}
    if where[1]:
        fields["message_thread_id"] = where[1]
    files = {f"p{i}": (f"step{i}.jpg", data) for i, (data, _) in enumerate(shots[:3])}
    try:
        return bool(_multipart("sendMediaGroup", fields, files).get("ok"))
    except Exception as e:
        log.info("hermes-chrome: Telegram report failed: %s", e)
        return notify(text)


def _multipart(method: str, fields: dict, files: dict) -> dict:
    boundary = "hc" + uuid.uuid4().hex
    body = bytearray()
    for k, v in fields.items():
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
    for k, (fname, data) in files.items():
        body += (f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"; filename="{fname}"\r\n'
                 "Content-Type: image/jpeg\r\n\r\n").encode() + data + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{_token()}/{method}", data=bytes(body), method="POST",
                                 headers={"content-type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def schedule_delete(state, chat_id, message_id, at: float) -> None:
    pending = list(state.get("pending_deletes", default=[]) or [])
    pending.append({"chat_id": chat_id, "message_id": message_id, "at": at})
    state.set("pending_deletes", pending)
    timer = threading.Timer(max(0.0, at - time.time()), _in_profile(_delete_due), args=(state,))
    timer.daemon = True
    timer.start()


def _delete_due(state) -> None:
    pending = list(state.get("pending_deletes", default=[]) or [])
    keep = []
    for p in pending:
        if p["at"] > time.time():
            keep.append(p)
            continue
        try:
            _bot("deleteMessage", {"chat_id": p["chat_id"], "message_id": p["message_id"]})
        except Exception as e:  # already deleted by the user, or older than Telegram's 48 h limit: drop it
            log.info("hermes-chrome: could not delete pairing message %s: %s", p["message_id"], e)
    state.set("pending_deletes", keep)


def resume(state) -> None:
    """On startup: delete overdue pairing messages and re-arm timers for the rest."""
    pending = list(state.get("pending_deletes", default=[]) or [])
    if not pending or not _token():
        return
    _delete_due(state)
    for p in state.get("pending_deletes", default=[]) or []:
        t = threading.Timer(max(0.0, p["at"] - time.time()), _in_profile(_delete_due), args=(state,))
        t.daemon = True
        t.start()

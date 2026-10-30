"""Recorded browser workflows, stored as Hermes skills: <HERMES_HOME>/skills/browser-recordings/<name>/.

SKILL.md tells the agent what the workflow does and how to run it; steps.json holds the steps that
chrome_replay sends to the extension. Typed values can be {{variables}}; secrets are never stored.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from .chat import _hermes_home

VAR = re.compile(r"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}")
ACTIONS = {"open", "navigate", "click", "type", "select", "key"}


def root() -> Path:
    return _hermes_home() / "skills" / "browser-recordings"


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")[:40]


def _label(s: dict) -> str:
    t = s.get("target") or {}
    n = t.get("name") or t.get("placeholder") or t.get("nameAttr") or t.get("tag") or "element"
    host = re.sub(r"^https?://([^/]+).*$", r"\1", s.get("url") or "")
    return {"open": f"Open {host}", "navigate": f"Go to {host}", "click": f'Click "{n}"',
            "type": f'Type a hidden value into "{n}" (you will be asked to type it)' if s.get("secret") else f'Type "{s.get("value")}" into "{n}"',
            "select": f'Choose "{s.get("label") or s.get("value")}" in "{n}"', "key": f"Press {s.get('key')}"}.get(s.get("action"), str(s.get("action")))


def clean(steps: list) -> list[dict]:
    out = []
    for s in steps or []:
        if not isinstance(s, dict) or s.get("action") not in ACTIONS:
            continue
        s = {k: v for k, v in s.items() if k in ("action", "url", "target", "value", "label", "key", "secret")}
        if s.get("secret"):
            s.pop("value", None)  # belt and braces: the extension already blanks secrets
        out.append(s)
    return out


def variables(steps: list[dict]) -> list[str]:
    names = []
    for s in steps:
        for m in VAR.findall(str(s.get("value") or "")):
            if m not in names:
                names.append(m)
    return names


def save(name: str, description: str, steps: list) -> Path:
    slug = slugify(name)
    if not slug:
        raise ValueError("Give the workflow a name.")
    steps = clean(steps)
    if len(steps) < 2:
        raise ValueError("Nothing to save: record at least one action after opening the page.")
    folder = root() / slug
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "steps.json").write_text(json.dumps({"name": slug, "description": description, "steps": steps}, indent=2))
    vars_ = variables(steps)
    desc = (description or f"Recorded browser workflow {slug}").replace("\n", " ").strip()
    lines = [
        "---", f"name: {slug}", f"description: {desc} (recorded browser workflow, run with chrome_replay)", "---", "",
        f"# {slug}", "", desc, "",
        "This was recorded in the user's Chrome. To run it:", "",
        f'1. `chrome_replay` with `name: "{slug}"`'
        + (f" and `vars` for: {', '.join(vars_)} (ask the user if you do not know them)." if vars_ else "."),
        "2. If replay stops at a step (the page changed), look at the page with `chrome_read_page` and finish the remaining steps yourself.",
        "3. When done, call `chrome_report` with a one-line summary.", "",
        "Steps:", "",
    ] + [f"{i}. {_label(s)}" for i, s in enumerate(steps, 1)]
    (folder / "SKILL.md").write_text("\n".join(lines) + "\n")
    return folder


def load(name: str) -> dict | None:
    f = root() / slugify(name) / "steps.json"
    try:
        return json.loads(f.read_text())
    except (OSError, ValueError):
        return None


def names() -> list[str]:
    r = root()
    return sorted(p.parent.name for p in r.glob("*/steps.json")) if r.is_dir() else []


def fill(steps: list[dict], values: dict) -> tuple[list[dict], list[str]]:
    """Substitute {{vars}}; returns (steps, missing variable names)."""
    missing = [v for v in variables(steps) if v not in (values or {})]
    if missing:
        return steps, missing
    filled = []
    for s in steps:
        s = dict(s)
        if "value" in s:
            s["value"] = VAR.sub(lambda m: str(values[m.group(1)]), str(s["value"]))
        filled.append(s)
    return filled, []


def list_all() -> list[dict]:
    out = []
    for n in names():
        d = load(n) or {}
        steps = d.get("steps") or []
        out.append({"name": n, "description": d.get("description", ""), "steps": len(steps), "vars": variables(steps)})
    return out


def delete(name: str) -> bool:
    import shutil
    folder = root() / slugify(name)
    if not slugify(name) or not (folder / "steps.json").is_file():  # only ever remove a recording folder
        return False
    shutil.rmtree(folder)
    return True

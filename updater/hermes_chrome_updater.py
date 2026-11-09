#!/usr/bin/env python3
"""Hermes Chrome update helper: a Chrome native messaging host (Python 3 standard library only).

The extension is loaded unpacked, so it cannot rewrite its own files. This helper does it on request:

  {"cmd": "status"}                 -> {installed, version, extensionDir, extensionVersion}
  {"cmd": "update", "force": false} -> {ok, from, to}

What it can do, and nothing else: download the latest official release zip from the fixed GitHub URL,
check its SHA-256 against the digest GitHub publishes for it, and replace the contents of the one
extension folder written into config.json at install time (looked up by the calling extension's id,
which the browser passes on the command line). The message cannot name a URL or a folder.

Messages are JSON, each prefixed with its length as a 4-byte little-endian integer (stdin/stdout).
"""
import hashlib
import io
import json
import os
import re
import shutil
import stat
import struct
import sys
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

HOST_VERSION = "1.0.0"
RELEASE_API = "https://api.github.com/repos/whoisdhana/hermes-chrome/releases/latest"
DOWNLOAD_PREFIX = "https://github.com/whoisdhana/hermes-chrome/releases/download/"
ASSET_NAME = "hermes-chrome-extension.zip"
EXTENSION_NAME = "Hermes Chrome"

HERE = Path(__file__).resolve().parent
CONFIG = HERE / "config.json"
LOG = HERE / "updater.log"

API_TIMEOUT = 15
DOWNLOAD_TIMEOUT = 60
MAX_MESSAGE = 1024 * 1024
MAX_ZIP = 50 * 1024 * 1024
MAX_UNZIPPED = 200 * 1024 * 1024
MAX_ENTRIES = 2000


class UpdateError(Exception):
    pass


# ------------------------------------------------------------------ protocol

def read_message(stream):
    raw = stream.read(4)
    if len(raw) < 4:
        return None
    (size,) = struct.unpack("<I", raw)
    if size > MAX_MESSAGE:
        raise UpdateError("Message too large.")
    data = stream.read(size)
    if len(data) < size:
        raise UpdateError("Message cut short.")
    return json.loads(data.decode("utf-8"))


def write_message(stream, obj):
    data = json.dumps(obj).encode("utf-8")
    stream.write(struct.pack("<I", len(data)) + data)
    stream.flush()


def log_error(text, log_path=None):
    path = Path(log_path or LOG)
    try:
        if path.exists() and path.stat().st_size > 200_000:
            path.write_text("")  # keep it small
        with path.open("a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {text}\n")
    except OSError:
        pass


# ------------------------------------------------------------------ config and versions

def caller_id(argv):
    """The browser starts the host with the caller's origin as the first argument: chrome-extension://<id>/."""
    for arg in argv[1:]:
        m = re.fullmatch(r"chrome-extension://([a-p]{32})/?", arg)
        if m:
            return m.group(1)
    return None


def extension_dir(ext_id, config_path=None):
    try:
        config = json.loads(Path(config_path or CONFIG).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise UpdateError("The update helper has no configuration. Run its installer again.")
    folder = (config.get("extensions") or {}).get(ext_id or "")
    if not folder:
        raise UpdateError("The update helper is not set up for this copy of the extension. Run its installer again.")
    return Path(folder)


def parse_version(v):
    if not isinstance(v, str) or not re.fullmatch(r"\d+(\.\d+){0,3}", v):
        raise UpdateError(f"Not a version number: {v!r}")
    parts = [int(x) for x in v.split(".")]
    return tuple(parts + [0] * (4 - len(parts)))


def read_manifest(folder):
    try:
        manifest = json.loads((Path(folder) / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise UpdateError(f"No readable manifest.json in {folder}.")
    if manifest.get("name") != EXTENSION_NAME:
        raise UpdateError(f"{folder} does not hold Hermes Chrome (manifest name is {manifest.get('name')!r}).")
    parse_version(manifest.get("version"))
    return manifest


# ------------------------------------------------------------------ network

class _HttpsOnlyRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.lower().startswith("https://"):
            raise UpdateError("Refused a redirect away from HTTPS.")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def http_get(url, timeout, limit, accept="application/octet-stream"):
    if not url.startswith("https://"):
        raise UpdateError("Only HTTPS downloads are allowed.")
    opener = urllib.request.build_opener(_HttpsOnlyRedirect)
    req = urllib.request.Request(url, headers={"User-Agent": f"hermes-chrome-updater/{HOST_VERSION}", "Accept": accept})
    try:
        with opener.open(req, timeout=timeout) as resp:
            data = resp.read(limit + 1)
    except UpdateError:
        raise
    except Exception as e:  # URLError, HTTPError, timeouts, TLS errors
        raise UpdateError(f"Download failed ({url.split('?')[0]}): {e}")
    if len(data) > limit:
        raise UpdateError("Download is larger than expected.")
    return data


def fetch_release():
    """Latest release metadata from the fixed GitHub API URL: {tag, url, digest, size}."""
    try:
        release = json.loads(http_get(RELEASE_API, API_TIMEOUT, MAX_MESSAGE, "application/vnd.github+json"))
    except ValueError:
        raise UpdateError("GitHub sent an unreadable release description.")
    asset = next((a for a in release.get("assets") or [] if a.get("name") == ASSET_NAME), None)
    if not asset:
        raise UpdateError(f"The latest release has no {ASSET_NAME}.")
    url = asset.get("browser_download_url") or ""
    if not url.startswith(DOWNLOAD_PREFIX):
        raise UpdateError("The release asset is not on the official download address.")
    digest = asset.get("digest") or ""
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise UpdateError("The release does not publish a SHA-256 digest for the zip, so it cannot be checked. Not updating.")
    return {"tag": release.get("tag_name"), "url": url, "digest": digest, "size": asset.get("size")}


def download(url):
    return http_get(url, DOWNLOAD_TIMEOUT, MAX_ZIP)


# ------------------------------------------------------------------ unpack and replace

def verify_digest(data, digest):
    want = digest.split(":", 1)[1] if digest.startswith("sha256:") else None
    if not want or hashlib.sha256(data).hexdigest() != want:
        raise UpdateError("The downloaded zip does not match the SHA-256 published with the release. Not updating.")


def safe_extract(data, dest):
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise UpdateError("The download is not a valid zip file.")
    infos = zf.infolist()
    if len(infos) > MAX_ENTRIES:
        raise UpdateError("The zip has too many entries.")
    total = 0
    for info in infos:
        name = info.filename
        parts = PurePosixPath(name).parts
        if (not name or name.startswith("/") or "\\" in name or re.match(r"^[A-Za-z]:", name)
                or ".." in parts or "\x00" in name):
            raise UpdateError(f"Refused an unsafe path in the zip: {name!r}")
        if stat.S_ISLNK(info.external_attr >> 16):
            raise UpdateError(f"Refused a symbolic link in the zip: {name!r}")
        total += info.file_size
        if total > MAX_UNZIPPED:
            raise UpdateError("The zip unpacks to more than expected.")
    dest = Path(dest)
    for info in infos:
        target = dest.joinpath(*PurePosixPath(info.filename).parts)
        if info.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        with zf.open(info) as src, open(target, "wb") as out:
            shutil.copyfileobj(src, out)


def _tree(root):
    dirs, files = set(), set()
    for base, dnames, fnames in os.walk(root):
        rel = Path(base).relative_to(root)
        for d in dnames:
            dirs.add((rel / d).as_posix())
        for f in fnames:
            files.add((rel / f).as_posix())
    return dirs, files


def _remove(path):
    if path.is_symlink() or not path.is_dir():
        path.unlink()
    else:
        shutil.rmtree(path)  # does not follow symlinks inside


def replace_contents(src, dst):
    """Make dst hold exactly the files of src. Only paths inside dst are written or removed; symlinks
    found inside dst are removed, never followed."""
    src, dst = Path(src), Path(os.path.realpath(dst))
    new_dirs, new_files = _tree(src)
    for rel in sorted(new_dirs):  # parents sort before children
        target = dst / rel
        if os.path.lexists(target) and (target.is_symlink() or not target.is_dir()):
            target.unlink()
        target.mkdir(exist_ok=True)
    for rel in sorted(new_files):
        target = dst / rel
        if os.path.lexists(target) and (target.is_symlink() or target.is_dir()):
            _remove(target)
        tmp = target.with_name(target.name + ".hc-update-tmp")
        shutil.copyfile(src / rel, tmp)
        os.replace(tmp, target)
    for base, dnames, fnames in os.walk(dst, topdown=False):
        for name in fnames + dnames:
            path = Path(base) / name
            rel = path.relative_to(dst).as_posix()
            if path.is_symlink() or (rel not in new_files and rel not in new_dirs):
                if os.path.lexists(path):
                    _remove(path)


def do_update(folder, force=False, fetch=None, get=None):
    fetch, get = fetch or fetch_release, get or download
    folder = Path(folder)
    current = read_manifest(folder)["version"]
    release = fetch()
    data = get(release["url"])
    if isinstance(release.get("size"), int) and len(data) != release["size"]:
        raise UpdateError("The download is not the size GitHub lists for it. Not updating.")
    verify_digest(data, release["digest"])
    with tempfile.TemporaryDirectory(prefix="hermes-chrome-update-") as tmp:
        safe_extract(data, tmp)
        try:
            new = read_manifest(tmp)
        except UpdateError as e:
            raise UpdateError(f"The release zip is not Hermes Chrome: {e}")
        c = (parse_version(new["version"]) > parse_version(current)) - (parse_version(new["version"]) < parse_version(current))
        if c < 0 or (c == 0 and not force):
            raise UpdateError(f"Already up to date: you have {current}, the latest release is {new['version']}.")
        replace_contents(tmp, folder)
    return {"ok": True, "from": current, "to": new["version"]}


# ------------------------------------------------------------------ entry point

def handle(msg, ext_id, config_path=None):
    cmd = (msg or {}).get("cmd")
    if cmd == "status":
        folder = extension_dir(ext_id, config_path)
        try:
            version = read_manifest(folder)["version"]
        except UpdateError:
            version = None
        return {"installed": True, "version": HOST_VERSION, "extensionDir": str(folder), "extensionVersion": version}
    if cmd == "update":
        return do_update(extension_dir(ext_id, config_path), force=bool(msg.get("force")))
    raise UpdateError(f"Unknown command: {cmd!r}")


def main(argv=None, stdin=None, stdout=None, config_path=None, log_path=None):
    argv = sys.argv if argv is None else argv
    stdin = stdin or sys.stdin.buffer
    stdout = stdout or sys.stdout.buffer
    try:
        msg = read_message(stdin)
        if msg is None:
            return 0
        reply = handle(msg, caller_id(argv), config_path)
    except UpdateError as e:
        log_error(str(e), log_path)
        reply = {"installed": True, "ok": False, "error": str(e)}
    except Exception as e:  # never die silently: the extension shows the error inline
        log_error(f"{type(e).__name__}: {e}", log_path)
        reply = {"installed": True, "ok": False, "error": f"Update helper error: {type(e).__name__}: {e}"}
    write_message(stdout, reply)
    return 0


if __name__ == "__main__":
    sys.exit(main())

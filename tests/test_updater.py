"""Update helper tests (standard library only): the native messaging protocol, the update logic against a
fake release, and install.sh's browser profile parsing with a fake HOME.

  python -m unittest discover -s tests
"""
import hashlib
import importlib.util
import io
import json
import os
import platform
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "updater" / "hermes_chrome_updater.py"
INSTALLER = ROOT / "updater" / "install.sh"
_spec = importlib.util.spec_from_file_location("hermes_chrome_updater", SCRIPT)
up = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(up)

EXT_ID = "abcdefghijklmnopabcdefghijklmnop"
OTHER_ID = "ponmlkjihgfedcbaponmlkjihgfedcba"


def frame(obj):
    data = json.dumps(obj).encode()
    return struct.pack("<I", len(data)) + data


def unframe(raw):
    (n,) = struct.unpack("<I", raw[:4])
    assert len(raw) == 4 + n, "exactly one framed reply"
    return json.loads(raw[4:])


def make_zip(files, extra=None):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
        for info, content in extra or []:
            zf.writestr(info, content)
    return buf.getvalue()


def manifest(version, name="Hermes Chrome"):
    return json.dumps({"manifest_version": 3, "name": name, "version": version})


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="hc-updater-test-"))
        self.ext = self.tmp / "ext"
        self.ext.mkdir()
        (self.ext / "manifest.json").write_text(manifest("0.7.0"))
        (self.ext / "background.js").write_text("old")
        (self.ext / "stale.js").write_text("remove me")
        (self.ext / "oldicons").mkdir()
        (self.ext / "oldicons" / "a.png").write_text("x")
        self.outside = self.tmp / "outside"
        self.outside.mkdir()
        (self.outside / "keep.txt").write_text("keep")
        os.symlink(self.outside, self.ext / "link")  # a symlink inside the folder must not be followed
        self.config = self.tmp / "config.json"
        self.config.write_text(json.dumps({"extensions": {EXT_ID: str(self.ext)}}))
        self.log = self.tmp / "updater.log"

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def release(self, data, digest=None):
        digest = digest or "sha256:" + hashlib.sha256(data).hexdigest()
        fetch = lambda: {"tag": "v0.8.0", "url": up.DOWNLOAD_PREFIX + "v0.8.0/" + up.ASSET_NAME, "digest": digest, "size": len(data)}
        return fetch, (lambda url: data)

    def snapshot(self):
        out = {}
        for p in sorted(self.ext.rglob("*")):
            out[p.relative_to(self.ext).as_posix()] = "link" if p.is_symlink() else ("dir" if p.is_dir() else p.read_text())
        return out


class Protocol(Base):
    def run_main(self, msg, argv=None):
        out = io.BytesIO()
        up.main(argv or ["host", f"chrome-extension://{EXT_ID}/"], io.BytesIO(frame(msg)), out, self.config, self.log)
        return unframe(out.getvalue())

    def test_status(self):
        r = self.run_main({"cmd": "status"})
        self.assertEqual(r, {"installed": True, "version": up.HOST_VERSION, "extensionDir": str(self.ext), "extensionVersion": "0.7.0"})

    def test_unknown_caller_is_refused(self):
        r = self.run_main({"cmd": "status"}, ["host", f"chrome-extension://{OTHER_ID}/"])
        self.assertFalse(r["ok"])
        self.assertIn("not set up for this copy", r["error"])
        r = self.run_main({"cmd": "status"}, ["host"])
        self.assertFalse(r["ok"])
        self.assertIn("not set up", self.log.read_text())

    def test_message_cannot_choose_folder_or_url(self):
        calls = []
        orig = up.do_update
        up.do_update = lambda folder, force=False: calls.append((str(folder), force)) or {"ok": True}
        try:
            self.run_main({"cmd": "update", "dir": "/etc", "url": "https://evil.example/x.zip", "extensionDir": "/"})
        finally:
            up.do_update = orig
        self.assertEqual(calls, [(str(self.ext), False)])

    def test_unknown_command(self):
        r = self.run_main({"cmd": "rm -rf"})
        self.assertFalse(r["ok"])
        self.assertIn("Unknown command", r["error"])

    def test_real_process_with_length_prefix(self):
        work = self.tmp / "host"
        work.mkdir()
        (work / SCRIPT.name).write_text(SCRIPT.read_text())
        (work / "config.json").write_text(self.config.read_text())
        p = subprocess.run([sys.executable, "-I", str(work / SCRIPT.name), f"chrome-extension://{EXT_ID}/"],
                           input=frame({"cmd": "status"}), capture_output=True, timeout=30)
        self.assertEqual(p.returncode, 0, p.stderr)
        r = unframe(p.stdout)
        self.assertTrue(r["installed"])
        self.assertEqual(r["extensionVersion"], "0.7.0")


class Update(Base):
    NEW = {"manifest.json": manifest("0.8.0"), "background.js": "new", "icons/icon16.png": "png", "link": "now a file"}

    def test_good_update(self):
        fetch, get = self.release(make_zip(self.NEW))
        r = up.do_update(self.ext, fetch=fetch, get=get)
        self.assertEqual(r, {"ok": True, "from": "0.7.0", "to": "0.8.0"})
        self.assertEqual(self.snapshot(), {"background.js": "new", "icons": "dir", "icons/icon16.png": "png",
                                           "link": "now a file", "manifest.json": manifest("0.8.0")})
        self.assertEqual(sorted(os.listdir(self.outside)), ["keep.txt"], "nothing outside the folder is touched")
        self.assertEqual((self.outside / "keep.txt").read_text(), "keep")
        self.assertEqual(sorted(os.listdir(self.tmp)), sorted(["ext", "outside", "config.json"]))

    def test_stale_symlink_removed_not_followed(self):
        files = dict(self.NEW)
        del files["link"]
        fetch, get = self.release(make_zip(files))
        up.do_update(self.ext, fetch=fetch, get=get)
        self.assertFalse(os.path.lexists(self.ext / "link"))
        self.assertTrue((self.outside / "keep.txt").exists())

    def test_bad_digest_refused(self):
        before = self.snapshot()
        fetch, get = self.release(make_zip(self.NEW), digest="sha256:" + "0" * 64)
        with self.assertRaisesRegex(up.UpdateError, "does not match the SHA-256"):
            up.do_update(self.ext, fetch=fetch, get=get)
        self.assertEqual(self.snapshot(), before)

    def test_missing_digest_fails_closed(self):
        release = {"tag_name": "v0.8.0", "assets": [{"name": up.ASSET_NAME, "size": 1,
                   "browser_download_url": up.DOWNLOAD_PREFIX + "v0.8.0/" + up.ASSET_NAME}]}
        orig = up.http_get
        up.http_get = lambda *a, **k: json.dumps(release).encode()
        try:
            with self.assertRaisesRegex(up.UpdateError, "does not publish a SHA-256"):
                up.fetch_release()
            release["assets"][0]["digest"] = "sha256:" + "a" * 64
            release["assets"][0]["browser_download_url"] = "https://evil.example/" + up.ASSET_NAME
            with self.assertRaisesRegex(up.UpdateError, "official download address"):
                up.fetch_release()
        finally:
            up.http_get = orig

    def test_http_only_https(self):
        with self.assertRaisesRegex(up.UpdateError, "Only HTTPS"):
            up.http_get("http://github.com/x", 1, 10)

    def test_path_traversal_refused(self):
        for evil in ("../escape.txt", "icons/../../escape.txt", "/tmp/hc-abs-escape.txt"):
            with self.subTest(evil=evil):
                before = self.snapshot()
                fetch, get = self.release(make_zip({**self.NEW, evil: "pwned"}))
                with self.assertRaisesRegex(up.UpdateError, "unsafe path"):
                    up.do_update(self.ext, fetch=fetch, get=get)
                self.assertEqual(self.snapshot(), before)
                self.assertFalse((self.tmp / "escape.txt").exists())
                self.assertFalse(Path("/tmp/hc-abs-escape.txt").exists())

    def test_symlink_entry_refused(self):
        info = zipfile.ZipInfo("evil-link")
        info.external_attr = (0o120777 << 16)
        fetch, get = self.release(make_zip(self.NEW, [(info, "/etc/passwd")]))
        with self.assertRaisesRegex(up.UpdateError, "symbolic link"):
            up.do_update(self.ext, fetch=fetch, get=get)

    def test_wrong_manifest_name_refused(self):
        before = self.snapshot()
        fetch, get = self.release(make_zip({**self.NEW, "manifest.json": manifest("0.8.0", "Totally Hermes")}))
        with self.assertRaisesRegex(up.UpdateError, "not Hermes Chrome"):
            up.do_update(self.ext, fetch=fetch, get=get)
        self.assertEqual(self.snapshot(), before)

    def test_installed_folder_must_be_hermes_chrome(self):
        (self.ext / "manifest.json").write_text(manifest("0.1.0", "Something else"))
        fetch, get = self.release(make_zip(self.NEW))
        with self.assertRaisesRegex(up.UpdateError, "does not hold Hermes Chrome"):
            up.do_update(self.ext, fetch=fetch, get=get)
        self.assertTrue((self.ext / "stale.js").exists())

    def test_older_version_refused(self):
        before = self.snapshot()
        fetch, get = self.release(make_zip({**self.NEW, "manifest.json": manifest("0.6.9")}))
        with self.assertRaisesRegex(up.UpdateError, "Already up to date"):
            up.do_update(self.ext, fetch=fetch, get=get)
        with self.assertRaisesRegex(up.UpdateError, "Already up to date"):
            up.do_update(self.ext, force=True, fetch=fetch, get=get)
        self.assertEqual(self.snapshot(), before)

    def test_equal_version_needs_force(self):
        fetch, get = self.release(make_zip({**self.NEW, "manifest.json": manifest("0.7.0")}))
        with self.assertRaisesRegex(up.UpdateError, "Already up to date"):
            up.do_update(self.ext, fetch=fetch, get=get)
        self.assertEqual(up.do_update(self.ext, force=True, fetch=fetch, get=get), {"ok": True, "from": "0.7.0", "to": "0.7.0"})
        self.assertEqual((self.ext / "background.js").read_text(), "new")

    def test_version_compare_is_numeric(self):
        fetch, get = self.release(make_zip({**self.NEW, "manifest.json": manifest("0.10.0")}))
        (self.ext / "manifest.json").write_text(manifest("0.9.5"))
        self.assertEqual(up.do_update(self.ext, fetch=fetch, get=get)["to"], "0.10.0")

    def test_update_through_protocol(self):
        fetch, get = self.release(make_zip(self.NEW))
        orig = up.fetch_release, up.download
        up.fetch_release, up.download = fetch, get
        try:
            out = io.BytesIO()
            up.main(["host", f"chrome-extension://{EXT_ID}/"], io.BytesIO(frame({"cmd": "update"})), out, self.config, self.log)
        finally:
            up.fetch_release, up.download = orig
        self.assertEqual(unframe(out.getvalue()), {"ok": True, "from": "0.7.0", "to": "0.8.0"})


@unittest.skipUnless(platform.system() in ("Darwin", "Linux"), "install.sh is for macOS and Linux")
class Installer(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="hc-install-home-"))
        if platform.system() == "Darwin":
            s = self.home / "Library" / "Application Support"
            self.chrome, self.brave, self.edge = s / "Google" / "Chrome", s / "BraveSoftware" / "Brave-Browser", s / "Microsoft Edge"
        else:
            c = self.home / ".config"
            self.chrome, self.brave, self.edge = c / "google-chrome", c / "BraveSoftware" / "Brave-Browser", c / "microsoft-edge"
        self.ext_a = self.ext_folder("Downloads/hermes-chrome-extension")
        self.ext_b = self.ext_folder("Downloads/hermes-chrome-extension (2)")
        self.other = self.ext_folder("Downloads/other", name="Other Thing")
        clone = self.home / "src" / "hermes-chrome"
        self.cloned = self.ext_folder("src/hermes-chrome/extension")
        (clone / ".git").mkdir()
        self.prefs(self.chrome / "Default" / "Secure Preferences", {
            EXT_ID: {"location": 4, "path": str(self.ext_a)},
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": {"location": 4, "path": str(self.other)},   # different extension
            "cccccccccccccccccccccccccccccccc": {"location": 1, "path": "cccc/1.0_0"},       # store install
            "dddddddddddddddddddddddddddddddd": {"location": 4, "path": str(self.cloned)},  # git checkout: skipped
        })
        self.prefs(self.chrome / "Profile 3" / "Preferences", {EXT_ID: {"location": 4, "path": str(self.ext_a)}})
        self.prefs(self.brave / "Profile 1" / "Secure Preferences", {OTHER_ID: {"location": 4, "path": str(self.ext_b)}})
        self.edge.mkdir(parents=True)  # installed browser without the extension: nothing registered
        self.env = {**{k: v for k, v in os.environ.items() if k != "XDG_CONFIG_HOME"}, "HOME": str(self.home)}

    def tearDown(self):
        import shutil
        shutil.rmtree(self.home, ignore_errors=True)

    def ext_folder(self, rel, name="Hermes Chrome"):
        d = self.home / rel
        d.mkdir(parents=True)
        (d / "manifest.json").write_text(manifest("0.7.0", name))
        return d

    def prefs(self, path, settings):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"extensions": {"settings": settings}}))

    def install(self, *args):
        p = subprocess.run(["bash", str(INSTALLER), *args], env=self.env, capture_output=True, text=True, timeout=120)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        return p.stdout + p.stderr

    def host_manifest(self, browser_dir):
        return json.loads((browser_dir / "NativeMessagingHosts" / "com.hermes_chrome.updater.json").read_text())

    def test_finds_extensions_and_registers_hosts(self):
        out = self.install()
        inst = self.home / ".hermes-chrome-updater"
        config = json.loads((inst / "config.json").read_text())
        self.assertEqual(config, {"extensions": {EXT_ID: os.path.realpath(self.ext_a), OTHER_ID: os.path.realpath(self.ext_b)}})
        chrome, brave = self.host_manifest(self.chrome), self.host_manifest(self.brave)
        self.assertEqual(chrome["allowed_origins"], [f"chrome-extension://{EXT_ID}/"])
        self.assertEqual(brave["allowed_origins"], [f"chrome-extension://{OTHER_ID}/"])
        self.assertEqual(chrome["name"], "com.hermes_chrome.updater")
        self.assertEqual(chrome["type"], "stdio")
        self.assertFalse((self.edge / "NativeMessagingHosts").exists())
        self.assertIn("git checkout", out)
        wrapper = Path(chrome["path"])
        self.assertEqual(wrapper, inst / "hermes-chrome-updater")
        self.assertTrue(os.access(wrapper, os.X_OK))

        # The registered host answers through the wrapper, as the browser would start it.
        p = subprocess.run([str(wrapper), f"chrome-extension://{OTHER_ID}/"], input=frame({"cmd": "status"}),
                           capture_output=True, timeout=30, env=self.env)
        self.assertEqual(unframe(p.stdout)["extensionDir"], os.path.realpath(self.ext_b))

        # Idempotent: a second run gives the same result.
        self.install()
        self.assertEqual(json.loads((inst / "config.json").read_text()), config)
        self.assertEqual(self.host_manifest(self.chrome), chrome)

        self.install("--uninstall")
        self.assertFalse(inst.exists())
        self.assertFalse((self.chrome / "NativeMessagingHosts" / "com.hermes_chrome.updater.json").exists())
        self.assertFalse((self.brave / "NativeMessagingHosts" / "com.hermes_chrome.updater.json").exists())

    def test_explicit_dir_and_id(self):
        self.install("--dir", str(self.ext_b), "--id", EXT_ID)
        config = json.loads((self.home / ".hermes-chrome-updater" / "config.json").read_text())
        self.assertEqual(config, {"extensions": {EXT_ID: os.path.realpath(self.ext_b)}})
        for d in (self.chrome, self.brave, self.edge):
            self.assertEqual(self.host_manifest(d)["allowed_origins"], [f"chrome-extension://{EXT_ID}/"])
        p = subprocess.run(["bash", str(INSTALLER), "--dir", str(self.other), "--id", EXT_ID], env=self.env,
                           capture_output=True, text=True, timeout=60)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("does not hold Hermes Chrome", p.stderr)

    def test_nothing_found(self):
        for f in (self.chrome / "Default" / "Secure Preferences", self.chrome / "Profile 3" / "Preferences",
                  self.brave / "Profile 1" / "Secure Preferences"):
            f.unlink()
        p = subprocess.run(["bash", str(INSTALLER)], env=self.env, capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 1)
        self.assertIn("Load unpacked", p.stderr)
        self.assertFalse((self.home / ".hermes-chrome-updater").exists())


if __name__ == "__main__":
    unittest.main()

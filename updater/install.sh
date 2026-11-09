#!/usr/bin/env bash
# Hermes Chrome one-click update helper: installer (macOS and Linux, user level, no sudo).
#
#   curl -fsSL https://raw.githubusercontent.com/whoisdhana/hermes-chrome/main/updater/install.sh | bash
#   bash install.sh [--dir <extension folder> --id <extension id>] [--uninstall]
#
# Installs the helper to ~/.hermes-chrome-updater/, finds the unpacked Hermes Chrome extension in
# Google Chrome, Chromium, Brave, Microsoft Edge and Arc (their profile Preferences files), writes the
# helper's config (extension id -> folder) and registers the native messaging host for each browser
# that has it, allowed for exactly those extension ids. Safe to run again. --uninstall removes it all.
set -euo pipefail

HOST_NAME="com.hermes_chrome.updater"
RAW_BASE="https://raw.githubusercontent.com/whoisdhana/hermes-chrome/main/updater"
INSTALL_DIR="$HOME/.hermes-chrome-updater"

DIR="" ID="" UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="${2:-}"; shift 2 ;;
    --id) ID="${2:-}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,11p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
if { [ -n "$DIR" ] && [ -z "$ID" ]; } || { [ -z "$DIR" ] && [ -n "$ID" ]; }; then
  echo "Use --dir and --id together." >&2; exit 2
fi

# Browser user data folders. A browser's user-level native messaging hosts live in <folder>/NativeMessagingHosts.
case "$(uname -s)" in
  Darwin)
    S="$HOME/Library/Application Support"
    BROWSERS=("Google Chrome|$S/Google/Chrome" "Google Chrome Beta|$S/Google/Chrome Beta" "Google Chrome Canary|$S/Google/Chrome Canary"
      "Chromium|$S/Chromium" "Brave|$S/BraveSoftware/Brave-Browser" "Microsoft Edge|$S/Microsoft Edge" "Arc|$S/Arc/User Data") ;;
  Linux)
    C="${XDG_CONFIG_HOME:-$HOME/.config}"
    BROWSERS=("Google Chrome|$C/google-chrome" "Google Chrome Beta|$C/google-chrome-beta" "Chromium|$C/chromium"
      "Brave|$C/BraveSoftware/Brave-Browser" "Microsoft Edge|$C/microsoft-edge") ;;
  *) echo "This installer supports macOS and Linux." >&2; exit 1 ;;
esac

if [ "$UNINSTALL" = 1 ]; then
  for b in "${BROWSERS[@]}"; do
    f="${b#*|}/NativeMessagingHosts/$HOST_NAME.json"
    if [ -f "$f" ]; then rm -f "$f"; echo "Removed $f"; fi
  done
  if [ -d "$INSTALL_DIR" ]; then rm -rf "$INSTALL_DIR"; echo "Removed $INSTALL_DIR"; fi
  echo "Hermes Chrome update helper uninstalled."
  exit 0
fi

PY="$(command -v python3 || true)"
if [ -z "$PY" ] || ! "$PY" -c 'import sys; sys.exit(sys.version_info < (3, 8))' 2>/dev/null; then
  echo "Python 3.8 or newer is needed (macOS: xcode-select --install, or brew install python)." >&2; exit 1
fi
PY="$("$PY" -c 'import sys; print(sys.executable)')" # absolute: browsers start hosts with a minimal PATH

# Find the extension: browser|id|folder lines.
FOUND="$(mktemp)"
trap 'rm -f "$FOUND"' EXIT
if [ -n "$DIR" ]; then
  if ! printf '%s' "$ID" | grep -Eq '^[a-p]{32}$'; then echo "--id must be a 32-letter extension id (a-p)." >&2; exit 2; fi
  DIR="$(cd "$DIR" && pwd -P)"
  if ! "$PY" -I -c 'import json, sys; sys.exit(json.load(open(sys.argv[1])).get("name") != "Hermes Chrome")' "$DIR/manifest.json" 2>/dev/null; then
    echo "$DIR does not hold Hermes Chrome (no manifest.json named \"Hermes Chrome\")." >&2; exit 1
  fi
  for b in "${BROWSERS[@]}"; do
    if [ -d "${b#*|}" ]; then printf '%s|%s|%s\n' "${b%%|*}" "$ID" "$DIR" >> "$FOUND"; fi
  done
  [ -s "$FOUND" ] || { echo "No supported browser found on this computer." >&2; exit 1; }
else
  printf '%s\n' "${BROWSERS[@]}" | "$PY" -I -c '
import json, os, sys
seen = set()
for line in sys.stdin.read().splitlines():
    browser, root = line.split("|", 1)
    if not os.path.isdir(root):
        continue
    for profile in sorted(os.listdir(root)):
        for name in ("Secure Preferences", "Preferences"):
            try:
                with open(os.path.join(root, profile, name), encoding="utf-8") as f:
                    exts = ((json.load(f).get("extensions") or {}).get("settings") or {})
            except (OSError, ValueError, AttributeError):
                continue
            for ext_id, s in exts.items():
                if not isinstance(s, dict) or s.get("location") not in (4, 8):  # 4 unpacked, 8 --load-extension
                    continue
                folder = s.get("path") or ""
                try:
                    with open(os.path.join(folder, "manifest.json"), encoding="utf-8") as f:
                        if json.load(f).get("name") != "Hermes Chrome":
                            continue
                except (OSError, ValueError, AttributeError):
                    continue
                folder = os.path.realpath(folder)
                if os.path.exists(os.path.join(os.path.dirname(folder), ".git")):  # <clone>/extension: updated with git
                    if folder not in seen:
                        seen.add(folder)
                        print("Skipping %s: it is a git checkout, update it with git pull." % folder, file=sys.stderr)
                    continue
                if (browser, ext_id, folder) not in seen:
                    seen.add((browser, ext_id, folder))
                    print("%s|%s|%s" % (browser, ext_id, folder))
' > "$FOUND"
  if [ ! -s "$FOUND" ]; then
    echo "Hermes Chrome was not found in any browser profile. Load it first (chrome://extensions, Developer mode," >&2
    echo "Load unpacked), then run this again, or pass --dir <extension folder> --id <extension id>." >&2
    exit 1
  fi
fi

# The helper itself: from this checkout when run as a file, otherwise from GitHub.
mkdir -p "$INSTALL_DIR"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-/nonexistent}")" 2>/dev/null && pwd || true)"
if [ -n "$SRC_DIR" ] && [ -f "$SRC_DIR/hermes_chrome_updater.py" ]; then
  cp "$SRC_DIR/hermes_chrome_updater.py" "$INSTALL_DIR/hermes_chrome_updater.py.new"
else
  curl -fsSL --max-time 60 "$RAW_BASE/hermes_chrome_updater.py" -o "$INSTALL_DIR/hermes_chrome_updater.py.new"
fi
"$PY" -I -c 'import ast, sys; ast.parse(open(sys.argv[1]).read())' "$INSTALL_DIR/hermes_chrome_updater.py.new"
mv "$INSTALL_DIR/hermes_chrome_updater.py.new" "$INSTALL_DIR/hermes_chrome_updater.py"
WRAPPER="$INSTALL_DIR/hermes-chrome-updater"
printf '#!/bin/sh\nexec "%s" -I "%s" "$@"\n' "$PY" "$INSTALL_DIR/hermes_chrome_updater.py" > "$WRAPPER"
chmod 755 "$WRAPPER"
chmod 644 "$INSTALL_DIR/hermes_chrome_updater.py"
echo "Installed the helper in $INSTALL_DIR"

# Config (id -> folder) and the host registration in every installed browser's folder.
"$PY" -I - "$FOUND" "$INSTALL_DIR" "$WRAPPER" "$HOST_NAME" "${BROWSERS[@]}" <<'PYEOF'
import json, os, sys
found_file, install_dir, wrapper, host_name, *browsers = sys.argv[1:]
roots = dict(b.split("|", 1) for b in browsers)
rows = [l.split("|", 2) for l in open(found_file, encoding="utf-8").read().splitlines() if l]
config = {"extensions": {}}
per_browser = {}
for browser, ext_id, folder in rows:
    if config["extensions"].get(ext_id, folder) != folder:
        print("Note: extension id %s points at two folders; using %s" % (ext_id, folder))
    config["extensions"][ext_id] = folder
    per_browser.setdefault(browser, set()).add(ext_id)
with open(os.path.join(install_dir, "config.json"), "w", encoding="utf-8") as f:
    json.dump(config, f, indent=2)
for ext_id, folder in sorted(config["extensions"].items()):
    print("Extension %s -> %s" % (ext_id, folder))
# Every installed Chromium-family browser's folder gets the same registration, allowed for every copy found.
# Browsers do not always read only their own folder (Brave on macOS has been seen to use Google Chrome's or
# Chromium's), so a copy in one browser must be allowed wherever that browser might look.
all_ids = sorted(config["extensions"])
manifest = {"name": host_name, "description": "Hermes Chrome update helper", "path": wrapper, "type": "stdio",
            "allowed_origins": ["chrome-extension://%s/" % i for i in all_ids]}
for browser, root in sorted(roots.items()):
    path = os.path.join(root, "NativeMessagingHosts", host_name + ".json")
    if all_ids and (os.path.isdir(root) or browser in per_browser):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2)
        print("%s: registered %s" % (browser, path))
    elif os.path.isfile(path):
        os.remove(path)
        print("%s: removed old registration %s" % (browser, path))
PYEOF

if ! "$PY" -I -c 'import urllib.request; urllib.request.urlopen("https://api.github.com", timeout=8)' >/dev/null 2>&1; then
  echo "Warning: $PY could not reach https://api.github.com (offline, or missing TLS certificates;"
  echo "for python.org Python run 'Install Certificates.command'). Updates will fail until it can."
fi
echo "Done. Open the Hermes Chrome side panel: the update banner now shows Update now."

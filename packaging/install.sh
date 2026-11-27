#!/usr/bin/env bash
# One-click install for the local web version, from the Battle Map tarball. No root needed.
#   ./install.sh [--no-service] [--prefix DIR]
# Puts the app in ~/.local/opt/battlemap, `battlemap` in ~/.local/bin, a menu entry, and (unless --no-service) a systemd
# user service that keeps the server running, so the page is always at http://127.0.0.1:4747 .
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
prefix="${HOME}/.local" service=1
while [ $# -gt 0 ]; do case "$1" in
  --no-service) service=0; shift ;; --prefix) prefix="${2:?--prefix needs a directory}"; shift 2 ;;
  -h|--help) sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;; *) echo "unknown option $1" >&2; exit 1 ;; esac; done
[ -d "$here/app" ] || { echo "run this from the unpacked Battle Map folder (it has an app/ directory next to it)" >&2; exit 1; }
node_bin="$here/node/bin/node"; [ -x "$node_bin" ] || node_bin="$(command -v node || true)"
[ -n "$node_bin" ] || { echo "Node.js 20 or newer is required (not found)" >&2; exit 1; }
major="$("$node_bin" -p 'process.versions.node.split(".")[0]')"; [ "$major" -ge 20 ] || { echo "Node.js 20 or newer is required (found $major)" >&2; exit 1; }
command -v gh >/dev/null 2>&1 || echo "note: the GitHub CLI (gh) is not installed. Battle Map reads GitHub through it: install https://cli.github.com and run 'gh auth login'" >&2

dest="$prefix/opt/battlemap"; bin="$prefix/bin"; apps="$prefix/share/applications"; icons="$prefix/share/icons/hicolor/scalable/apps"
mkdir -p "$dest" "$bin" "$apps" "$icons"
rm -rf "$dest/app" "$dest/node"; cp -a "$here/app" "$dest/app"; [ -d "$here/node" ] && cp -a "$here/node" "$dest/node"; cp "$here/launch.sh" "$dest/launch.sh"; chmod +x "$dest/launch.sh"
ln -sf "$dest/launch.sh" "$bin/battlemap"
cp "$here/battlemap.svg" "$icons/battlemap.svg"
sed "s|^Exec=.*|Exec=$dest/launch.sh|" "$here/battlemap.desktop" > "$apps/battlemap.desktop"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$apps" >/dev/null 2>&1 || true
echo "installed to $dest  (command: $bin/battlemap)"
case ":$PATH:" in *":$bin:"*) ;; *) echo "note: $bin is not on your PATH; add it, or use the menu entry" ;; esac

if [ "$service" = 1 ] && command -v systemctl >/dev/null 2>&1; then
  unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"; mkdir -p "$unit"
  cat > "$unit/battlemap.service" <<UNIT
[Unit]
Description=Battle Map: every repo as a city
After=network-online.target

[Service]
ExecStart=$dest/launch.sh --server
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload && systemctl --user enable --now battlemap.service && echo "running as a service: http://127.0.0.1:4747  (logs: journalctl --user -u battlemap)" || echo "could not start the service; run 'battlemap' to start it by hand"
else
  echo "start it with: battlemap"
fi

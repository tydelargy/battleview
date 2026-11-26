#!/usr/bin/env bash
# Install Battle Map as two systemd user units: the server, and a timer that refreshes the PR feed every two minutes.
# Fills in absolute paths, because user services do not see your shell's PATH.
#
#   deploy/install-systemd.sh --repo org/repo [--host ghe.example.com] [--checkout DIR] [--feed FILE] [--dest DIR] [--no-enable]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
data="${XDG_DATA_HOME:-$HOME/.local/share}/battlemap"
repo="" host="" checkout="$data/repo" feed="$data/prs.json" dest="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user" enable=1

usage() { sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="${2:?--repo needs owner/name}"; shift 2 ;;
    --host) host="${2:?--host needs a hostname}"; shift 2 ;;
    --checkout) checkout="${2:?--checkout needs a directory}"; shift 2 ;;
    --feed) feed="${2:?--feed needs a file}"; shift 2 ;;
    --dest) dest="${2:?--dest needs a directory}"; shift 2 ;;
    --no-enable) enable=0; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown option $1" >&2; usage 1 ;;
  esac
done
[ -n "$repo" ] || { echo "--repo is required, for example --repo org/repo" >&2; usage 1; }
case "$repo" in */*) ;; *) echo "--repo should look like owner/name" >&2; exit 1 ;; esac

# Prefer an installed `battlemap` / `battlemap-sync` (npm link); fall back to running from this checkout with node.
node_bin="$(command -v node || true)"; [ -n "$node_bin" ] || { echo "node is not on PATH" >&2; exit 1; }
bm="$(command -v battlemap || true)";      [ -n "$bm" ]   || bm="$node_bin $root/bin/battlemap.js"
sync="$(command -v battlemap-sync || true)"; [ -n "$sync" ] || sync="$node_bin $root/bin/battlemap-sync.js"
gh="$(command -v gh || true)"; [ -n "$gh" ] || { echo "the GitHub CLI (gh) is not on PATH: install https://cli.github.com and run gh auth login${host:+ --hostname $host}" >&2; exit 1; }
git="$(command -v git || true)"; [ -n "$git" ] || { echo "git is not on PATH" >&2; exit 1; }

mkdir -p "$dest" "$(dirname "$feed")"
render() {   # render <template> <output>
  sed -e "s|@BATTLEMAP@|$bm|g" -e "s|@SYNC@|$sync|g" -e "s|@GH@|$gh|g" -e "s|@GIT@|$git|g" -e "s|@CHECKOUT@|$checkout|g" \
      -e "s|@FEED@|$feed|g" -e "s|@REPO@|$repo|g" -e "s|@HOSTNAME@|${host:-github.com}|g" -e "s|@HOSTARG@|${host:+--host $host }|g" "$1" > "$2"
}
render "$here/battlemap.service.in"      "$dest/battlemap.service"
render "$here/battlemap-sync.service.in" "$dest/battlemap-sync.service"
cp "$here/battlemap-sync.timer.in"       "$dest/battlemap-sync.timer"
echo "wrote battlemap.service, battlemap-sync.service and battlemap-sync.timer to $dest"

[ -d "$checkout/.git" ] || echo "note: $checkout is not a git checkout yet. Clone the repo there first, for example:
  git clone <url of $repo> $checkout"

if [ "$enable" = 1 ]; then
  systemctl --user daemon-reload
  systemctl --user enable --now battlemap-sync.timer battlemap.service
  echo "running. Open http://127.0.0.1:4747 . Logs: journalctl --user -u battlemap -u battlemap-sync"
else
  echo "not enabled. To start: systemctl --user daemon-reload && systemctl --user enable --now battlemap-sync.timer battlemap.service"
fi

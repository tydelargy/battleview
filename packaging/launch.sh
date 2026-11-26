#!/bin/sh
# Battle Map launcher, the same in every Linux package (deb, AppImage, install tarball).
#   battlemap              start the server if it is not running, then open the browser
#   battlemap --no-open    the same without the browser
#   battlemap --server     run the server in the foreground (this is what the systemd service runs)
#   battlemap --stop       stop the server this launcher started
# BATTLEMAP_PORT (default 4747) and BATTLEMAP_DATA (default ~/.local/share/battlemap) are honoured.
home="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"            # <home>/app, <home>/node (optional, bundled)
node_bin="$home/node/bin/node"; [ -x "$node_bin" ] || node_bin="$(command -v node || true)"
if [ -z "$node_bin" ]; then echo "Battle Map needs Node.js 20 or newer. Install it, or use the AppImage, which carries its own." >&2; exit 1; fi
port="${BATTLEMAP_PORT:-4747}"; state="${XDG_STATE_HOME:-$HOME/.local/state}/battlemap"; mkdir -p "$state"
case "${1:-}" in
  --server) exec "$node_bin" "$home/app/bin/battlemap.js" --hub --port "$port" ;;
  --stop) [ -f "$state/pid" ] && kill "$(cat "$state/pid")" 2>/dev/null; rm -f "$state/pid"; exit 0 ;;
esac
up() { "$node_bin" -e "fetch('http://127.0.0.1:$port/api/hub/world').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"; }
if ! up; then
  nohup "$node_bin" "$home/app/bin/battlemap.js" --hub --port "$port" >>"$state/log" 2>&1 &
  echo $! >"$state/pid"; i=0
  until up; do i=$((i + 1)); if [ "$i" -gt 60 ]; then echo "Battle Map did not start. See $state/log" >&2; exit 1; fi; sleep 0.25; done
fi
[ "${1:-}" = "--no-open" ] && exit 0
url="http://127.0.0.1:$port"
xdg-open "$url" >/dev/null 2>&1 || echo "Battle Map is running: open $url in your browser"

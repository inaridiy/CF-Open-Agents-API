#!/bin/sh
# `wrangler dev` for rootless Docker. Added by create-cf-open-agents-api.
#
# A temporary workaround. Wrangler's local container proxy assumes the Docker bridge
# gateway (172.17.0.1) sits in workerd's own network namespace. That holds for rootful
# Docker only: with rootless Docker the bridge lives in rootlesskit's namespace, so requests
# from the containers back to the Worker (model.internal, sandbox.internal) never arrive and
# every turn fails with `internal_error` or `connection_failed`. This script runs wrangler
# inside rootlesskit's namespace and bridges its port back to the host over a Unix socket,
# so http://localhost:$PORT (default 8787) keeps working, SSH port forwarding included.
# It changes nothing about the Docker daemon or the host network. Delete it once Wrangler
# supports rootless engines.
#
# WRANGLER names the command that runs the project's wrangler (the package.json script sets
# it, e.g. `pnpm exec wrangler`); PORT the port wrangler listens on and the host publishes.
set -eu
cd "$(dirname "$0")/.."
port="${PORT:-8787}"
runtime="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
rootless="$runtime/dockerd-rootless"
if [ ! -r "$rootless/child_pid" ]; then
  echo "dev-rootless: $rootless/child_pid not found; is rootless Docker running for this user?" >&2
  echo "dev-rootless: with rootful Docker run wrangler dev directly." >&2
  exit 1
fi
pid="$(cat "$rootless/child_pid")"
# `--detach-netns` keeps the namespace in a file; otherwise it is the daemon's own.
if [ -e "$rootless/netns" ]; then
  netns="/proc/$pid/root$rootless/netns"
else
  netns="/proc/$pid/ns/net"
fi
resolv="$rootless/resolv.conf"
sock="$runtime/cf-open-agents-api-dev-$port.sock"
rm -f "$sock"

# Both long-running commands run in the background under `wait`, so a signal reaches the
# trap at once (a trap waits for a foreground command to finish first) and the trap can
# stop every child. A background command's stdin is /dev/null; fd 3 keeps the terminal
# for wrangler's hotkeys.
exec 3<&0
# Host side of the bridge: 127.0.0.1:$port -> Unix socket.
node scripts/netns-bridge.mjs tcp-to-unix "$port" "$sock" &
bridge=$!

nsenter --user="/proc/$pid/ns/user" --net="$netns" --preserve-credentials \
  unshare --mount sh -c '
    set -eu
    sock="$1"; port="$2"; resolv="$3"; shift 3
    # The bind mount is private to this process tree; the host resolver is not touched.
    mount --make-rprivate /
    if [ -r "$resolv" ]; then mount --bind "$resolv" /etc/resolv.conf; fi
    exec 3<&0
    # Namespace side of the bridge: Unix socket -> 127.0.0.1:$port, where wrangler listens.
    node scripts/netns-bridge.mjs unix-to-tcp "$sock" "$port" &
    inner_bridge=$!
    # Unquoted on purpose: WRANGLER is a command line such as `pnpm exec wrangler`.
    ${WRANGLER:-npx wrangler} dev --port "$port" "$@" <&3 &
    wrangler=$!
    trap "kill $wrangler $inner_bridge 2>/dev/null" EXIT INT TERM HUP
    wait $wrangler
  ' dev-rootless "$sock" "$port" "$resolv" "$@" <&3 &
inner=$!
trap 'kill $inner $bridge 2>/dev/null; rm -f "$sock"' EXIT INT TERM HUP
wait $inner

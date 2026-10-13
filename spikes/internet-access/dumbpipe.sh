#!/usr/bin/env bash
# Runs both ends of dumbpipe (n0's native iroh tunnel) on this PC, forwarding to the paired
# Mac's sshd, then bench.cjs through it. Prints the dumbpipe processes' CPU time.
#
#   ./dumbpipe.sh <path to dumbpipe.exe> direct|relay
#
# Get dumbpipe from https://github.com/n0-computer/dumbpipe/releases (v0.39.0 was measured).
set -u
DP="$1"
MODE="${2:-direct}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mktemp -d)"
MAC=$(node -e "const c=require(require('path').join(process.env.CAPMAC_CONFIG_DIR||require('os').homedir()+'/.capmac','config.json'));const h=c.hosts[c.defaultHost];console.log((h.lastAddress||h.host)+':'+h.port)")
if [ "$MODE" = relay ]; then
  # No address family in common, so every byte goes through n0's public relay.
  LAN=$(node -e "
    const p='${MAC%:*}'.split('.').slice(0,3).join('.')+'.';
    const l=Object.values(require('os').networkInterfaces()).find(l=>l.some(i=>i.family==='IPv4'&&i.address.startsWith(p)));
    const v6=(l.find(i=>i.family==='IPv6'&&!i.address.startsWith('fe80'))||{}).address;
    console.log(l.find(i=>i.family==='IPv4').address+' '+(v6||''))")
  read -r V4 V6 <<< "$LAN"
  LISTEN_ARGS=(--ipv4-addr 127.0.0.1:0 --ipv6-addr "[::1]:0")
  CONNECT_ARGS=(--ipv4-addr "$V4:0")
  [ -n "$V6" ] && CONNECT_ARGS+=(--ipv6-addr "[$V6]:0")
else
  LISTEN_ARGS=()
  CONNECT_ARGS=()
fi
"$DP" listen-tcp --host "$MAC" "${LISTEN_ARGS[@]}" 2> "$OUT/listen.err" &
LISTEN_PID=$!
for _ in $(seq 1 100); do grep -q 'endpoint[a-z0-9]\{20,\}' "$OUT/listen.err" && break; sleep 0.1; done
TICKET=$(grep -o 'endpoint[a-z0-9]\{20,\}' "$OUT/listen.err" | head -1)
if [ -z "$TICKET" ]; then
  echo "dumbpipe printed no ticket:"; cat "$OUT/listen.err"; kill "$LISTEN_PID"; exit 1
fi
"$DP" connect-tcp --addr 127.0.0.1:2222 "${CONNECT_ARGS[@]}" "$TICKET" 2> "$OUT/connect.err" &
CONNECT_PID=$!
sleep 1
cpu() { powershell.exe -NoProfile -Command "(Get-Process -Name dumbpipe | Measure-Object -Property CPU -Sum).Sum" | tr -d '\r'; }
BEFORE=$(cpu)
SPIKE_TCP=127.0.0.1:2222 node "$HERE/bench.cjs" tcp
AFTER=$(cpu)
echo "dumbpipe CPU seconds, both ends: $(node -e "console.log(($AFTER-$BEFORE).toFixed(1))")"
kill "$CONNECT_PID" "$LISTEN_PID" 2>/dev/null
wait 2>/dev/null
rm -rf "$OUT"

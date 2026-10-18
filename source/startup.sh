#!/bin/sh
set -eu
cd /workspace
# :8081 is QA-only — a revive must never inherit a stale built-output preview.
node scripts/preview.mjs stop || true
if ! curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
  npm run dev >>/tmp/app-startup.log 2>&1 &
fi
POLLER_PID=/tmp/telegram-poller.pid
if [ -f "$POLLER_PID" ] && kill -0 "$(cat "$POLLER_PID")" 2>/dev/null; then
  :
else
  node scripts/telegram-poller.mjs >>/tmp/telegram-poller.log 2>&1 &
  echo $! > "$POLLER_PID"
fi
TUNNEL_PID=/tmp/telegram-tunnel.pid
if [ -f "$TUNNEL_PID" ] && kill -0 "$(cat "$TUNNEL_PID")" 2>/dev/null; then
  :
else
  node scripts/telegram-tunnel.mjs >>/tmp/telegram-tunnel.log 2>&1 &
  echo $! > "$TUNNEL_PID"
fi

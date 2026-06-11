#!/usr/bin/env bash
# Acompanha os jobs #1 (N8N) e #2 (MAKE) no daemon até done/failed. Sai (notifica) no fim.
set -u
MKI=/home/nmaldaner/projetos/openpcbot/skills/mkivideos/mki.sh
LOG=/tmp/mki-track.log
: > "$LOG"
say(){ echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }
st(){ bash "$MKI" status "$1" 2>/dev/null | grep -oE '\[[a-z]+\]' | head -1; }
term(){ bash "$MKI" status "$1" 2>/dev/null | grep -qE '\[(done|failed|canceled)\]'; }

prev1=""; prev2=""
say "tracking #1 (n8n) e #2 (make)"
for i in $(seq 1 720); do   # até 12h
  s1=$(st 1); s2=$(st 2)
  [ "$s1" != "$prev1" ] && { say "#1 n8n  -> $s1"; prev1="$s1"; }
  [ "$s2" != "$prev2" ] && { say "#2 make -> $s2"; prev2="$s2"; }
  if term 1 && term 2; then break; fi
  sleep 30
done
say "=== FIM ==="
bash "$MKI" status 1 | tee -a "$LOG"
bash "$MKI" status 2 | tee -a "$LOG"

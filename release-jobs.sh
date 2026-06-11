#!/usr/bin/env bash
# Segura 2 jobs de curso e SÓ enfileira quando a máquina esvaziar (render do Pequeno Príncipe terminar).
# Depois acompanha os jobs no daemon até done/failed. Sai (notifica) no fim.
set -u
MKI=/home/nmaldaner/projetos/openpcbot/skills/mkivideos/mki.sh
LOG=/tmp/mki-release.log
: > "$LOG"
say(){ echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

say "watcher armado · aguardando máquina livre (sem 'pequeno-principe' e load<12)"

# 1) GATE: espera os outros processos terminarem
for i in $(seq 1 360); do   # até 6h
  pp=$(pgrep -fc 'pequeno-principe' 2>/dev/null || echo 0)
  hr=$(pgrep -fc 'hyperframes render' 2>/dev/null || echo 0)
  load=$(cut -d' ' -f1 /proc/loadavg)
  free=$(awk -v l="$load" -v p="$pp" -v h="$hr" 'BEGIN{print (p==0 && h==0 && l<12)?1:0}')
  if [ "$free" = "1" ]; then say "máquina livre (load $load) — liberando os jobs"; break; fi
  [ $((i % 5)) -eq 0 ] && say "ainda ocupado (pequeno-principe=$pp hyperframes=$hr load=$load) — esperando…"
  sleep 60
done

# 2) ENFILEIRA os 2 cursos (16:9 = default)
id1=$(bash "$MKI" add curso "https://inematds.github.io/N8Nb/" --curso n8n 2>>"$LOG" | grep -oE '#[0-9]+' | head -1)
say "enfileirado N8N -> $id1"
id2=$(bash "$MKI" add curso "https://inematds.github.io/MAKE/" --curso make 2>>"$LOG" | grep -oE '#[0-9]+' | head -1)
say "enfileirado MAKE -> $id2"
n1=${id1#\#}; n2=${id2#\#}

# 3) ACOMPANHA até os dois terminarem
term(){ bash "$MKI" status "$1" 2>/dev/null | grep -qE '\[(done|failed|canceled)\]'; }
for i in $(seq 1 720); do   # até 12h
  s1=$(bash "$MKI" status "$n1" 2>/dev/null | grep -oE '\[[a-z]+\]' | head -1)
  s2=$(bash "$MKI" status "$n2" 2>/dev/null | grep -oE '\[[a-z]+\]' | head -1)
  [ $((i % 5)) -eq 0 ] && say "N8N=$s1 MAKE=$s2"
  if term "$n1" && term "$n2"; then break; fi
  sleep 60
done

say "=== FIM ==="
bash "$MKI" status "$n1" | tee -a "$LOG"
bash "$MKI" status "$n2" | tee -a "$LOG"
bash "$MKI" stats | tee -a "$LOG"

# Deploy — mkivideos como serviço autônomo

mkivideos roda como **daemon systemd (user)**: worker (modo background+poll) + dashboard HTTP.
Banco próprio, independente do openpcbot. Ver `../docs/DIAGNOSTICO-SERVICO-AUTONOMO.md`.

## Instalar (user unit)

```bash
cd ~/projetos/mkivideos
npm install && npm run build            # gera dist/
mkdir -p renders
cp deploy/mkivideos.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now mkivideos.service
systemctl --user status mkivideos.service
journalctl --user -u mkivideos.service -f   # logs
```

Dashboard: <http://localhost:3142/videos?token=inemadash> (fila + estatísticas + máquina).

> **DB limpo (decisão do dono):** o daemon começa com `mkivideos.db` novo. NÃO migramos os
> `video_jobs` antigos do `store/openpcbot.db` (histórico era ~93% cancelado/falho).

## Config (Environment no unit ou export)

| Var | Default | O quê |
|---|---|---|
| `MKIVIDEOS_DB` | `~/projetos/mkivideos/mkivideos.db` | banco SQLite da fila |
| `MKIVIDEOS_CONCURRENCY` | `1` | quantos vídeos renderizam ao mesmo tempo |
| `MKIVIDEOS_RENDER_DIR` | `renders` | pasta-base dos `.mp4` |

> **Concorrência (P1):** mantenha `1` se a máquina é compartilhada com outras sessões de render.
> Em host folgado (CPU ociosa), suba pra `2`–`3` (`concorrência × ~4–6 workers ≲ núcleos`) pra ~3× throughput.

## Usar (CLI = cliente v1)

```bash
mkivideos add curso https://inematds.github.io/skills-craft --curso skills-craft --modulo t1m1-o-que-e-uma-agent-skill
mkivideos fila
mkivideos stats                 # status + por curso (X/Y) + ETA
mkivideos status <id>
mkivideos get <id>              # caminho do .mp4 (vazio se não pronto)
mkivideos cancelar <id>
```

Outro processo (ex.: openpcbot) vira **cliente fino**: shella esses comandos no mesmo host
(transporte v1 = CLI). HTTP JSON fica pro v2.

## Worker background+poll (P7)

O daemon NÃO segura uma sessão de agente por 1–2h. Por job: o agente faz o **setup** (conteúdo →
spec → narração → build) e **dispara o render destacado** gravando no caminho-alvo, emitindo
`RENDER: <path>` e saindo. O worker então **vigia o arquivo** até existir e estabilizar, e marca
`done`. É o que faz o curso profundo terminar (era o P7).

# Pendências — decisões em aberto (mkivideos)

Itens levantados que precisam de **decisão do dono do projeto**. Não implementar sem aval.

---

## P1 — Concorrência da fila: manter `1` ou permitir `~3` paralelo?

**Status:** em aberto, aguardando decisão.
**Origem:** medição real no projeto FEP (`~/projetos/videos-explicativos/fep-videos/`, ver `RELATORIO-FEP-VIDEOS.md` §5), 2026-06-04.

### Contexto
O README do mkivideos parte da premissa: *"render satura CPU; rodar vários trava a máquina; por isso a fila serializa (concorrência = 1)."* A medição empírica **refina** essa premissa.

### Dados medidos (host atual)
- **20 núcleos de CPU** + 1 GPU NVIDIA GB10.
- Cada render HyperFrames usa **~6 workers de Chrome ≈ 6 núcleos**.
- Rodando **1 por vez** (concorrência atual), só ~6 de 20 núcleos são usados → **~14 núcleos ociosos** (load ~11–16, muita folga).
- **GPU NÃO ajuda** este pipeline: o gargalo é a **captura de frames** (CPU); GPU fica 0% mesmo com `--gpu --browser-gpu` (NVENC existe, mas encode é fração mínima do tempo).
- 18 módulos do FEP rodaram **em série** e levaram horas; em paralelo de ~3 teriam levado **~1/3**.

### Proposta a decidir
Tornar a concorrência **configurável** (ex.: env/flag `CONCURRENCY`, default conservador), em vez de `1` fixo:
- Regra de segurança: `concorrência × workers_por_render ≲ núcleos` (ex.: 3 × 6 ≈ 18 ≤ 20).
- Ou auto: `floor(nproc / workers_por_render) - 1`.
- Opcional: só subir a concorrência quando `load < núcleos` (coordenar com outras sessões/projetos no mesmo host).

### Trade-offs
- ✅ **~3× throughput** sem GPU, aproveitando CPU ociosa — relevante para produção em **volume** (muitos cursos/vídeos).
- ⚠️ Em host **compartilhado** (outras sessões renderizando), paralelizar volta a saturar (foi o que deixou o FEP lento no início, load 27–33). Por isso a premissa original de serializar **não está errada** — depende do host estar livre.
- ⚠️ Mais RAM (cada worker Chrome ~256 MB; 18 workers ≈ vários GB).

### Recomendação (não decisão)
Manter default = **1** (seguro, host-agnóstico), mas **expor** concorrência configurável + checagem de load, pra quem tem máquina folgada (como esta, 20 núcleos) ligar o paralelo e ganhar ~3×.

---

## P2 — (menor) Alinhar nomes de saída com prefixo ordenável

No FEP os finais foram renomeados para `<trilha>-<módulo>-...mp4` (ex.: `1-1-...`, `4-6-...`) para ordenar na sequência do curso. Avaliar se a fila do mkivideos deve gerar nomes já ordenáveis por padrão (prefixo numérico configurável), em vez de pós-renomear.

---

## P3 — Marca d'água persistente (nome do curso + inema.club)

**Origem:** pedido do Nei, 2026-06-08.

Hoje os vídeos só têm a **CTA INEMA.CLUB na última cena** + o ghost text de fundo. Falta uma
**marca d'água persistente** visível o vídeo inteiro, com:
- **nome do curso** (ex.: "Skills Craft", "Skill Design");
- **inema.club**.

Aplicar em `videos-cursos-inema` (e avaliar em `video-explicativo`). Onde: provável canto
(rodapé/superior) discreto, dentro das safe zones (não conflitar com legenda/UI no 9:16).
Implementação: elemento fixo no `engine.mjs`/template (não por cena), com o nome do curso vindo do spec.

## P4 — Nomenclatura de saída pra IMPORT/PUBLICAÇÃO

**Origem:** pedido do Nei, 2026-06-08. (Relaciona com P2.)

Hoje o id é tipo `deep-<trilha>-mN` / `curso-xxxx-nomemodulo`. Falta um nome de arquivo que
**identifique na hora de importar/publicar** — pro pipeline de publicação saber o que é cada arquivo
sem abrir. Codificar no nome (a decidir a ordem exata): **curso · trilha · módulo nº · nome do módulo ·
formato (16x9/9x16)** — e idealmente **ordenável** (prefixo numérico, ver P2).
Ex.: `skills-craft_t1-m1_o-que-e-uma-skill_16x9.mp4`.
Objetivo: importar/publicar em lote identificando curso+trilha+módulo+formato só pelo nome.

## P5 — Status da fila por CURSO + progresso X/Y

**Origem:** pedido do Nei, 2026-06-08.

Hoje `/mkivideos fila` e o dashboard mostram cada job cru (skill + input/URL truncada). Falta:
- **Agrupar/rotular por nome do curso** (ex.: "Skills Craft", "Skill Design") em vez da URL.
- **Progresso do total**: `X/Y feito` por curso/grupo (ex.: `skills-craft — 3/25 feito`), e um total geral.
- Idealmente: nome do **módulo** em cada job (não a URL), e o curso como cabeçalho do grupo.

Onde: `formatQueueList` (Telegram) e o dashboard `/videos` (agrupar por curso, contar done/total).
Requer um campo de agrupamento no job (ex.: `course` + `module` no schema, ou derivar do input).
Conecta com P4 (nomenclatura) — mesmo metadado (curso·trilha·módulo) serve pros dois.

**P5 (cont.) — separar PROCESSANDO × ESPERA:** o status deve mostrar claramente, em duas seções:
- **Processando agora** (job `running`) — qual curso/módulo está sendo feito neste momento;
- **Na lista de espera** (os outros jobs `queued`, na ordem) — o que ainda falta.
Tanto no `/mkivideos fila` (Telegram) quanto no dashboard, com o progresso X/Y por curso ao lado.

## P6 — Dashboard otimizado (gráficos, máquina, refresh ajustável)

**Origem:** pedido do Nei, 2026-06-08. (Engloba/estende P5.)

Evoluir o painel `/videos` de "tabela simples" para um dashboard de operação:
- **Gráficos com histórico e previsão:**
  - histórico: jobs concluídos ao longo do tempo, throughput (jobs/h), tempo médio por job/curso;
  - **previsão/ETA:** quando a fila termina (baseado no tempo médio de render × jobs restantes), ETA por curso.
- **Lista abaixo** dos gráficos: os jobs (com P5 — agrupado por curso, processando × espera, X/Y feito, nome do módulo).
- **Informações da máquina:** núcleos/CPU + load, GPU, RAM, disco, nº de render workers ativos,
  progresso do render atual (%), modo de render (screenshot vs beginframe).
- **Frequência de atualização:** **ajustável** (ex.: 2s/5s/15s/off) **ou refresh manual** (botão), em vez do 5s fixo.

Quick-fix relacionado (urgente, fora do v2): hoje `listJobs()` tem `LIMIT 50` e ordena pelos mais novos
→ com fila grande o **job `running` (mais antigo) some** do dashboard e do `/mkivideos fila`. Subir o limite
(ex.: 1000) ou sempre incluir running+queued sem corte. Afeta dashboard `/videos` e `formatQueueList`.

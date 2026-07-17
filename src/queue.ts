// Núcleo da fila de vídeos — puro e host-agnóstico.
// parse/prompt/extract são funções puras; processNextJob/initVideoQueue recebem
// um QueueStore (persistência) e QueueDeps (IO) injetados.

import type { ParsedCommand, QueueDeps, QueueStore, VideoJob } from './types.js';

const SKILL_SLUGS: Record<VideoJob['skill'], string> = {
  explicativo: 'video-explicativo',
  curso: 'videos-cursos-inema',
  demo: 'video-demonstrativo',
  // 'transcrever'/'dublar' não usam skill do Claude Code — driblam direto o inemavox
  // (ver buildInemavoxPrompt). Entradas aqui só por completude do Record.
  transcrever: 'inemavox/transcrever_v1.py',
  dublar: 'inemavox/dublar_pro_v5.py',
};

const SKILL_LABEL: Record<VideoJob['skill'], string> = {
  explicativo: 'explicativo',
  curso: 'curso INEMA',
  demo: 'demonstrativo',
  transcrever: 'transcrição',
  dublar: 'dublagem',
};

/**
 * Extensão(ões) esperada(s) do artefato final de cada skill — o que torna o pipeline
 * extension-agnostic: os skills de vídeo produzem .mp4; 'transcrever' produz TEXTO
 * (.txt é o primário, .srt também é aceito); 'dublar' produz .mp4 (vídeo dublado).
 * A primeira extensão da lista é a usada em buildOutputName/o nome-alvo default.
 */
export const SKILL_ARTIFACT_EXTS: Record<VideoJob['skill'], string[]> = {
  explicativo: ['mp4'],
  curso: ['mp4'],
  demo: ['mp4'],
  dublar: ['mp4'],
  transcrever: ['txt', 'srt'],
};

const INEMAVOX_SKILLS = new Set<VideoJob['skill']>(['transcrever', 'dublar']);

/** Skills que delegam pro inemavox (usam buildInemavoxPrompt). */
function isInemavoxSkill(skill: VideoJob['skill']): skill is 'transcrever' | 'dublar' {
  return INEMAVOX_SKILLS.has(skill);
}

/** Caminho parece um arquivo (tem extensão), não uma pasta — extension-agnostic (.mp4/.txt/.srt/…). */
export function isFileTarget(p: string): boolean {
  return /\.[A-Za-z0-9]{1,5}$/.test(p);
}

const ALL_SKILLS = ['explicativo', 'curso', 'demo', 'transcrever', 'dublar'] as const;

/** Parseia o texto após "/mkivideos" (o caso de enfileirar). */
export function parseVideoCommand(raw: string): ParsedCommand {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { ok: false, error: 'Uso: /mkivideos <explicativo|curso|demo|transcrever|dublar> <assunto/link> [--vertical] [--enviar] [--silencioso] [--pasta <caminho>]' };
  }

  const skillToken = tokens[0].toLowerCase();
  if (!(ALL_SKILLS as readonly string[]).includes(skillToken)) {
    return { ok: false, error: `Skill inválida "${skillToken}". Use: explicativo, curso, demo, transcrever ou dublar.` };
  }
  const skill = skillToken as VideoJob['skill'];

  const rest = tokens.slice(1);
  let vertical = false, send = false, silent = false;
  let dest: string | undefined;
  let course: string | undefined;
  let mod: string | undefined;
  const inputTokens: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '--vertical') vertical = true;
    else if (t === '--enviar') send = true;
    else if (t === '--silencioso') silent = true;
    else if (t === '--pasta') { dest = rest[i + 1]; i++; } // consome o valor
    else if (t === '--curso') { course = rest[i + 1]; i++; }
    else if (t === '--modulo') { mod = rest[i + 1]; i++; }
    else if (t.startsWith('--')) { /* flag desconhecida: ignora */ }
    else inputTokens.push(t);
  }
  const input = inputTokens.join(' ').trim();
  if (!input) return { ok: false, error: 'Faltou o assunto/link depois da skill.' };
  return { ok: true, skill, input, vertical, send, silent, dest, course, module: mod };
}

/**
 * Prompt autônomo para o agente.
 * - Sem `outPath`: modo síncrono legado — o agente renderiza e emite `RESULT:` (fallback).
 * - Com `outPath` (modo background+poll, P7): o agente faz o SETUP, dispara o render
 *   DESTACADO gravando exatamente em `outPath`, emite `RENDER: <outPath>` e SAI sem esperar.
 *   O worker vigia o arquivo até ficar pronto. Resolve o P7 (sessão não segura 1–2h).
 */
export function buildVideoPrompt(
  job: { skill: 'explicativo' | 'curso' | 'demo'; input: string; vertical: boolean },
  outPath?: string,
): string {
  const slug = SKILL_SLUGS[job.skill];
  const formato = job.vertical ? 'Formato 9:16 (vertical, Shorts/Reels).' : 'Use o formato padrão da skill.';
  const base = [
    `Use a skill \`${slug}\` para criar um vídeo a partir de: "${job.input}".`,
    formato,
    'Rode de forma AUTÔNOMA, sem pedir confirmação de frames nem qualquer interação — assuma os defaults do usuário (PT-BR, dark premium âmbar, CTA INEMA.CLUB).',
  ];
  if (outPath) {
    return [
      ...base,
      `Faça TODO o setup (conteúdo → spec → narração/TTS → build do index.html).`,
      `Depois DISPARE o render em BACKGROUND DESTACADO (ex.: \`nohup npx hyperframes render --quality high --output "${outPath}" >/tmp/mki-render-$$.log 2>&1 &\`), gravando EXATAMENTE em: ${outPath}`,
      `NÃO espere o render terminar. Assim que ele estiver disparado, sua ÚLTIMA linha deve ser exatamente: \`RENDER: ${outPath}\``,
      'O serviço vai vigiar esse arquivo até ficar pronto — você pode encerrar a sessão logo após disparar.',
      'Se NÃO conseguir nem disparar o render, sua ÚLTIMA linha deve ser: `ERRO: <motivo curto>`.',
    ].join('\n');
  }
  return [
    ...base,
    'No RENDER FINAL use a GPU: `npx hyperframes render --quality high --gpu --browser-gpu` com `timeout 900`. Se o .mp4 sair vazio (GPU falhar), faça fallback pro CPU: `npx hyperframes render --quality high` (sem flags de GPU).',
    'Ao terminar com sucesso, sua ÚLTIMA linha deve ser exatamente: `RESULT: <caminho absoluto do .mp4 final>`.',
    'Se falhar, sua ÚLTIMA linha deve ser: `ERRO: <motivo curto>`.',
  ].join('\n');
}

/**
 * Prompt autônomo pra 'transcrever'/'dublar': NÃO usa skill de vídeo — driblam o inemavox
 * (~/projetos/inemavox, READ-ONLY, não modificar) diretamente pelos scripts CLI reais:
 *   - transcrever: `transcrever_v1.py --in <link> --outdir <dir> --asr whisper --whisper-model large-v3`
 *     (grava `<dir>/transcript.txt` e `<dir>/transcript.srt` — sem flag de arquivo único).
 *   - dublar: `dublar_pro_v5.py --in <link> --tgt pt --tts edge --out <outPath>` (grava direto em `--out`).
 * Mesmo contrato RENDER:/RESULT:/ERRO: do buildVideoPrompt — mesma janela de timeout do worker.
 */
export function buildInemavoxPrompt(
  job: { skill: 'transcrever' | 'dublar'; input: string },
  outPath?: string,
): string {
  const isTranscrever = job.skill === 'transcrever';
  const base = [
    `Use o inemavox (pasta ~/projetos/inemavox, SOMENTE LEITURA — não edite nada lá dentro) para ${isTranscrever ? 'TRANSCREVER' : 'DUBLAR'} a partir de: "${job.input}".`,
    'Rode de forma AUTÔNOMA, sem pedir confirmação nem qualquer interação.',
  ];
  const cmd = isTranscrever
    ? [
      `Rode (a partir de ~/projetos/inemavox): \`python3 transcrever_v1.py --in "${job.input}" --outdir <diretório temporário> --asr whisper --whisper-model large-v3\`.`,
      `Esse script NÃO aceita caminho de saída único — ele grava \`<outdir>/transcript.txt\` e \`<outdir>/transcript.srt\`. Depois de rodar, copie/mova o \`transcript.txt\` (ou o \`.srt\` se o destino pedido terminar em .srt) para o caminho-alvo abaixo.`,
    ]
    : [
      `Rode (a partir de ~/projetos/inemavox): \`python3 dublar_pro_v5.py --in "${job.input}" --tgt pt --tts edge --out <caminho-alvo>\` — esse script já grava o .mp4 dublado exatamente no caminho de \`--out\`.`,
    ];
  const artifact = isTranscrever ? 'TEXTO (transcrição .txt, aceita também .srt)' : 'vídeo dublado .mp4';
  if (outPath) {
    return [
      ...base,
      ...cmd,
      `Faça TODO o trabalho (download + transcrição/dublagem) e DISPARE em BACKGROUND DESTACADO (ex.: \`nohup bash -c '...' >/tmp/mki-${job.skill}-$$.log 2>&1 &\`), garantindo que o artefato final (${artifact}) fique gravado EXATAMENTE em: ${outPath}`,
      `NÃO espere terminar. Assim que disparar, sua ÚLTIMA linha deve ser exatamente: \`RENDER: ${outPath}\``,
      'O serviço vai vigiar esse arquivo até ficar pronto — você pode encerrar a sessão logo após disparar.',
      'Se NÃO conseguir nem disparar, sua ÚLTIMA linha deve ser: `ERRO: <motivo curto>`.',
    ].join('\n');
  }
  return [
    ...base,
    ...cmd,
    `Ao terminar com sucesso, sua ÚLTIMA linha deve ser exatamente: \`RESULT: <caminho absoluto do artefato final (${artifact})>\`.`,
    'Se falhar, sua ÚLTIMA linha deve ser: `ERRO: <motivo curto>`.',
  ].join('\n');
}

/** Extrai o caminho do artefato do output do agente (última linha `RESULT:`). Null se ausente/ERRO.
 *  `exts` restringe as extensões aceitas (default `['mp4']`, compat com os skills de vídeo). */
export function extractResultPath(text: string | null, exts: string[] = ['mp4']): string | null {
  const alt = exts.map((e) => e.replace(/^\./, '')).join('|');
  return lastMatch(text, new RegExp(`^\\s*RESULT:\\s*(\\S+\\.(?:${alt}))\\s*$`, 'i'));
}

/** Extrai o caminho-alvo do render destacado (última linha `RENDER:`). Null se ausente.
 *  `exts` restringe as extensões aceitas (default `['mp4']`). */
export function extractRenderTarget(text: string | null, exts: string[] = ['mp4']): string | null {
  const alt = exts.map((e) => e.replace(/^\./, '')).join('|');
  return lastMatch(text, new RegExp(`^\\s*RENDER:\\s*(\\S+\\.(?:${alt}))\\s*$`, 'i'));
}

function lastMatch(text: string | null, re: RegExp): string | null {
  if (!text) return null;
  let found: string | null = null;
  for (const line of text.split('\n')) {
    const m = line.match(re);
    if (m) found = m[1].trim();
  }
  return found;
}

/** slug seguro pra nome de arquivo (minúsculo, sem acento, hífens). */
export function slugify(s: string): string {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Nome de arquivo de saída no padrão ordenável/identificável (P4):
 * `<curso>-<modulo>-<16|9>.mp4`. Sem curso/módulo, cai pra `mkivideo-<id>-<fmt>.mp4`.
 * O enfileirador deve passar `module` já como "t1m1-o-que-e-uma-skill" pra bater o padrão.
 */
export function buildOutputName(job: Pick<VideoJob, 'id' | 'course' | 'module' | 'opts'>, ext: string = 'mp4'): string {
  let vertical = false;
  if (job.opts) { try { vertical = !!(JSON.parse(job.opts) as { vertical?: boolean }).vertical; } catch { /* ignora */ } }
  const fmt = vertical ? '9' : '16';
  const course = job.course ? slugify(job.course) : '';
  const mod = job.module ? slugify(job.module) : '';
  if (course && mod) return `${course}-${mod}-${fmt}.${ext}`;
  if (course) return `${course}-${fmt}.${ext}`;
  return `mkivideo-${job.id}-${fmt}.${ext}`;
}

/** Um vídeo-filho que o PLANNER decidiu enfileirar. */
export interface PlannedChild { skill: VideoJob['skill']; input: string; course?: string; module?: string; vertical?: boolean }

/**
 * Prompt do job PLANNER: o agente classifica o input, escolhe a skill, mapeia a estrutura
 * (curso → módulos) e emite UMA linha `ENQUEUE:` por vídeo a produzir. Não renderiza.
 */
export function buildPlannerPrompt(input: string): string {
  return [
    `Você é o PLANEJADOR de uma fila de vídeos. Recebeu este input: "${input}".`,
    `1) Classifique: é um site de CURSO (tem trilhas/módulos), um ASSUNTO único, ou um link de APP?`,
    `2) Escolha a skill: curso (videos-cursos-inema) · explicativo (video-explicativo) · demo (video-demonstrativo).`,
    `3) Se for CURSO: abra o site, mapeie as trilhas e os módulos, e emita UMA linha ENQUEUE por vídeo a produzir — a landing, cada trilha (índice) e 1 aula profunda por MÓDULO. Se for ASSUNTO ou APP: emita UMA linha ENQUEUE só.`,
    `Formato EXATO de cada linha (uma por vídeo, sem markdown):`,
    `ENQUEUE: skill=<curso|explicativo|demo> | input=<url-do-modulo-ou-assunto> | course=<slug-do-curso> | module=<t1m1-nome | landing | trilha-1> | vertical=0`,
    `NÃO renderize nada — só mapeie e emita as linhas ENQUEUE (o worker cria 1 job de vídeo por linha).`,
    `Na ÚLTIMA linha escreva exatamente: \`PLAN_DONE: <quantidade de linhas ENQUEUE>\`. Se não conseguir, última linha: \`ERRO: <motivo curto>\`.`,
  ].join('\n');
}

/** Extrai os filhos a enfileirar das linhas `ENQUEUE:` do output do planner. */
export function extractEnqueues(text: string | null): PlannedChild[] {
  if (!text) return [];
  const out: PlannedChild[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*ENQUEUE:\s*(.+)$/i);
    if (!m) continue;
    const f: Record<string, string> = {};
    for (const part of m[1].split('|')) {
      const i = part.indexOf('=');
      if (i > 0) f[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
    }
    const skill = f.skill as VideoJob['skill'];
    if (!['curso', 'explicativo', 'demo'].includes(skill) || !f.input) continue;
    out.push({ skill, input: f.input, course: f.course || undefined, module: f.module || undefined, vertical: /^(1|true|sim)$/i.test(f.vertical || '') });
  }
  return out;
}

/** Renderiza a fila ativa (running + queued) para `/mkivideos fila`. */
export function formatQueueList(jobs: VideoJob[]): string {
  const running = jobs.filter((j) => j.status === 'running');
  const queued = jobs.filter((j) => j.status === 'queued').sort((a, b) => a.created_at - b.created_at || a.id - b.id);
  const active = [...running, ...queued];
  if (active.length === 0) return '📭 Fila vazia.';
  const line = (jb: VideoJob) => {
    const icon = jb.status === 'running' ? '▶️' : '⏳';
    const inp = jb.input.length > 40 ? jb.input.slice(0, 40) + '…' : jb.input;
    return `${icon} #${jb.id} ${jb.skill} — ${inp}`;
  };
  return ['📋 Fila de vídeos:', ...active.map(line)].join('\n');
}

/**
 * Status RICO da fila (texto p/ Telegram): resumo geral + por curso (X/Y) + processando × espera.
 * Recebe a lista COMPLETA de jobs (inclui done/failed) pra calcular o X/Y.
 */
export function formatQueueStatus(jobs: VideoJob[]): string {
  if (!jobs.length) return '📭 Fila vazia. Nenhum job ainda.';
  const by = { queued: 0, running: 0, done: 0, failed: 0, canceled: 0 } as Record<VideoJob['status'], number>;
  for (const j of jobs) by[j.status]++;

  // agrupa por curso
  const cmap = new Map<string, { done: number; total: number; running: number; queued: number; failed: number }>();
  for (const j of jobs) {
    if (j.status === 'canceled') continue;
    const key = j.course || '(sem curso)';
    let c = cmap.get(key);
    if (!c) { c = { done: 0, total: 0, running: 0, queued: 0, failed: 0 }; cmap.set(key, c); }
    c.total++;
    if (j.status === 'done') c.done++;
    else if (j.status === 'running') c.running++;
    else if (j.status === 'queued') c.queued++;
    else if (j.status === 'failed') c.failed++;
  }

  const label = (j: VideoJob): string => {
    const tag = j.module || (j.input.length > 32 ? j.input.slice(0, 32) + '…' : j.input);
    return `#${j.id} ${j.course ? j.course + ' · ' : ''}${tag}`;
  };
  const running = jobs.filter((j) => j.status === 'running');
  const queued = jobs.filter((j) => j.status === 'queued').sort((a, b) => a.created_at - b.created_at || a.id - b.id);

  const out: string[] = ['📋 Fila de Vídeos', ''];
  out.push(`📊 ▶️ ${by.running} rodando · ⏳ ${by.queued} na fila · ✅ ${by.done} prontos · ❌ ${by.failed} falhas`);

  const courses = [...cmap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (courses.length && !(courses.length === 1 && courses[0][0] === '(sem curso)')) {
    out.push('', 'Por curso:');
    for (const [name, c] of courses) {
      const extra = [c.running && `${c.running} rodando`, c.queued && `${c.queued} fila`, c.failed && `${c.failed} falha`].filter(Boolean).join(' · ');
      const check = c.done === c.total ? ' ✅' : '';
      out.push(`  • ${name}: ${c.done}/${c.total} feito${extra ? ' (' + extra + ')' : ''}${check}`);
    }
  }

  out.push('', `▶️ Processando agora${running.length ? '' : ': —'}`);
  for (const j of running) out.push(`  ${label(j)}`);

  if (queued.length) {
    out.push('', `⏳ Na espera (${queued.length}):`);
    for (const j of queued.slice(0, 15)) out.push(`  ${label(j)}`);
    if (queued.length > 15) out.push(`  …+${queued.length - 15}`);
  }
  return out.join('\n');
}

/** Texto de ajuda do `/mkivideos help` (e quando chamado sem args). HTML simples. */
export function mkiHelpText(): string {
  return [
    '🎬 <b>/mkivideos</b> — fila de vídeos (1 por vez)',
    '',
    '<b>Criar vídeo:</b>',
    '  /mkivideos explicativo &lt;assunto&gt;',
    '  /mkivideos curso &lt;link do curso&gt;',
    '  /mkivideos demo &lt;link do app&gt;',
    '',
    '<b>Delegam pro inemavox (produtos standalone, mesma fila GPU):</b>',
    '  /mkivideos transcrever &lt;link&gt;  baixa + transcreve local (Whisper) → .txt/.srt',
    '  /mkivideos dublar &lt;link&gt;       baixa + dubla com IA → .mp4',
    '',
    '<b>Flags (no fim):</b>',
    '  --vertical    gera 9:16 (Shorts/Reels) em vez do padrão — só nos skills de vídeo',
    '  --enviar      anexa o arquivo final (.mp4/.txt/.srt) no Telegram ao terminar',
    '  --silencioso  não notifica; aparece só no painel',
    '  --pasta &lt;caminho&gt;  move o arquivo final pra essa pasta (ou caminho de arquivo completo)',
    '  --curso &lt;nome&gt;     rótulo do curso (agrupa nas estatísticas)',
    '  --modulo &lt;label&gt;   rótulo do módulo (ex.: t1m1-o-que-e-uma-skill)',
    '',
    '<b>Fila:</b>',
    '  /mkivideos fila               mostra a fila',
    '  /mkivideos fila cancelar &lt;id&gt;  cancela um job que ainda espera',
    '  /mkivideos help               esta ajuda',
  ].join('\n');
}

/** Opções do worker (concorrência, modo background+poll, diretório de render). */
export interface WorkerOptions {
  /** Quantos jobs rodam ao mesmo tempo. Default 1 (seguro/host-agnóstico). */
  concurrency?: number;
  /** Intervalo do tick do worker (initVideoQueue). Default 15s. */
  intervalMs?: number;
  /**
   * Modo background+poll (P7): o agente dispara o render destacado e emite `RENDER:`;
   * o worker vigia o arquivo via deps.waitForFile. Default false (legado síncrono `RESULT:`).
   */
  background?: boolean;
  /** Diretório-base dos renders quando não há --pasta .mp4 explícita. Default 'renders'. */
  renderDir?: string;
  /** Timeout (ms) do poll do arquivo no modo background. */
  pollTimeoutMs?: number;
  /** Janela (ms) de estabilidade de tamanho pra considerar o render pronto. */
  pollStableMs?: number;
}

function parseOpts(raw: string | null): { vertical?: boolean; dest?: string } {
  if (!raw) return {};
  try { return JSON.parse(raw) as { vertical?: boolean; dest?: string }; }
  catch { return {}; }
}

const joinPath = (dir: string, name: string): string => `${dir.replace(/\/+$/, '')}/${name}`;

/**
 * Processa no máximo um job. No-op se a concorrência já estiver cheia.
 * Default concorrência = 1 e modo síncrono (`RESULT:`) — compatível com o uso legado.
 */
export async function processNextJob(store: QueueStore, deps: QueueDeps, opts: WorkerOptions = {}): Promise<void> {
  const concurrency = opts.concurrency ?? 1;
  if (store.runningCount() >= concurrency) return;
  const job = store.getNext();
  if (!job) return;
  store.markRunning(job.id);
  await runClaimedJob(store, deps, job, opts);
}

/** Executa um job já marcado 'running' até done/failed. Não checa concorrência (quem chama já reservou). */
async function runClaimedJob(store: QueueStore, deps: QueueDeps, job: VideoJob, opts: WorkerOptions): Promise<void> {
  const notify = job.notify === 'sempre' && job.chat_id;

  // Job PLANNER: classifica + mapeia + enfileira 1 job 'video' por peça. Não renderiza.
  if (job.kind === 'plan') {
    if (notify) await deps.sendMessage(job.chat_id!, `▶️ Planejando #${job.id}…`);
    try {
      const result = await deps.runAgent(buildPlannerPrompt(job.input));
      const children = extractEnqueues(result.text);
      if (!children.length) {
        const reason = lastErr(result.text) || 'planner não emitiu nenhuma linha ENQUEUE';
        store.markFailed(job.id, reason);
        if (notify) await deps.sendMessage(job.chat_id!, `❌ Plano #${job.id} falhou: ${reason}`);
        return;
      }
      for (const c of children) {
        const childOpts = c.vertical ? JSON.stringify({ vertical: true }) : null;
        store.enqueue({
          skill: c.skill, input: c.input, opts: childOpts,
          notify: job.notify, sendVideo: !!job.send_video, chatId: job.chat_id,
          course: c.course ?? null, module: c.module ?? null, kind: 'video', parentId: job.id,
        });
      }
      store.markDone(job.id, `planned:${children.length}`);
      if (notify) await deps.sendMessage(job.chat_id!, `🗂️ Plano #${job.id}: ${children.length} vídeo(s) enfileirado(s).`);
    } catch (e) {
      store.markFailed(job.id, (e as Error).message || String(e));
    }
    return;
  }

  if (notify) await deps.sendMessage(job.chat_id!, `▶️ Iniciando #${job.id} (${SKILL_LABEL[job.skill]})`);

  try {
    const o = parseOpts(job.opts);
    const background = opts.background ?? false;
    const exts = SKILL_ARTIFACT_EXTS[job.skill];
    const buildPrompt = (outPath?: string): string =>
      isInemavoxSkill(job.skill)
        ? buildInemavoxPrompt({ skill: job.skill, input: job.input }, outPath)
        : buildVideoPrompt({ skill: job.skill, input: job.input, vertical: !!o.vertical }, outPath);

    if (background) {
      // alvo determinístico que o worker vai vigiar
      const destIsFile = !!o.dest && isFileTarget(o.dest);
      const renderDir = opts.renderDir ?? 'renders';
      const target = destIsFile ? o.dest! : joinPath(renderDir, buildOutputName(job, exts[0]));

      const result = await deps.runAgent(buildPrompt(target));
      const rendered = extractRenderTarget(result.text, exts);
      if (!rendered) {
        const reason = lastErr(result.text) || 'agente não disparou o render (sem RENDER:)';
        store.markFailed(job.id, reason);
        if (notify) await deps.sendMessage(job.chat_id!, `❌ #${job.id} falhou: ${reason}`);
        return;
      }
      store.setRenderTarget(job.id, rendered);
      if (!deps.waitForFile) {
        store.markFailed(job.id, 'worker sem waitForFile (não dá pra vigiar o render em background)');
        return;
      }
      const ok = await deps.waitForFile(rendered, { timeoutMs: opts.pollTimeoutMs, stableMs: opts.pollStableMs });
      if (!ok) {
        store.markFailed(job.id, `render não completou no tempo — alvo ${rendered}`);
        if (notify) await deps.sendMessage(job.chat_id!, `❌ #${job.id} falhou: render não completou (timeout)`);
        return;
      }
      let finalPath = rendered;
      if (o.dest && !destIsFile) {
        try { finalPath = await deps.moveVideo(rendered, o.dest); }
        catch (e) { if (notify) await deps.sendMessage(job.chat_id!, `⚠ #${job.id} renderizou mas não movi pra ${o.dest}: ${(e as Error).message}`); }
      }
      store.markDone(job.id, finalPath);
      if (notify) await deps.sendMessage(job.chat_id!, `✅ #${job.id} pronto — ${SKILL_LABEL[job.skill]}\n${finalPath}`);
      if (job.send_video && job.chat_id) {
        try { await deps.sendDocument(job.chat_id, finalPath); }
        catch (e) { if (notify) await deps.sendMessage(job.chat_id, `(não consegui anexar o arquivo: ${(e as Error).message})`); }
      }
      return;
    }

    // modo síncrono legado: o agente faz tudo e emite RESULT:
    const result = await deps.runAgent(buildPrompt());
    const path = extractResultPath(result.text, exts);
    if (!path) {
      const reason = lastErr(result.text) || 'sem RESULT no output do agente';
      store.markFailed(job.id, reason);
      if (notify) await deps.sendMessage(job.chat_id!, `❌ #${job.id} falhou: ${reason}`);
      return;
    }
    let finalPath = path;
    if (o.dest) {
      try { finalPath = await deps.moveVideo(path, o.dest); }
      catch (e) {
        finalPath = path;
        if (notify) await deps.sendMessage(job.chat_id!, `⚠ #${job.id} renderizou mas não consegui mover pra ${o.dest}: ${(e as Error).message}. Ficou em ${path}`);
      }
    }
    store.markDone(job.id, finalPath);
    if (notify) await deps.sendMessage(job.chat_id!, `✅ #${job.id} pronto — ${SKILL_LABEL[job.skill]}\n${finalPath}`);
    if (job.send_video && job.chat_id) {
      try { await deps.sendDocument(job.chat_id, finalPath); }
      catch (e) { if (notify) await deps.sendMessage(job.chat_id, `(não consegui anexar o arquivo: ${(e as Error).message})`); }
    }
  } catch (e) {
    const msg = (e as Error).message || String(e);
    store.markFailed(job.id, msg);
    if (notify) await deps.sendMessage(job.chat_id!, `❌ #${job.id} falhou: ${msg}`);
  }
}

function lastErr(text: string | null): string | null {
  return text?.split('\n').reverse().find((l) => /ERRO:/i.test(l))?.trim() || null;
}

/**
 * Liga o worker num tick periódico. Chame uma vez no boot. Retorna um stop().
 * Aceita `intervalMs` (number, legado) ou um objeto WorkerOptions (concorrência, background, etc).
 * A cada tick, enche até `concurrency` jobs em paralelo (reserva síncrona evita corrida).
 */
export function initVideoQueue(store: QueueStore, deps: QueueDeps, opts: number | WorkerOptions = {}): () => void {
  const o: WorkerOptions = typeof opts === 'number' ? { intervalMs: opts } : opts;
  const intervalMs = o.intervalMs ?? 15_000;
  const concurrency = o.concurrency ?? 1;
  const tick = (): void => {
    while (store.runningCount() < concurrency) {
      const job = store.getNext();
      if (!job) break;
      store.markRunning(job.id);                 // reserva síncrona: o próximo getNext não repega
      void runClaimedJob(store, deps, job, o).catch(() => { /* já tratado em markFailed */ });
    }
  };
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}

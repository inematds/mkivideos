// Contratos do motor de fila — host-agnósticos (ports & adapters).
// Um host (openpcbot, openclaw, hermes…) implementa QueueStore + QueueDeps;
// o motor (parse/prompt/worker) não sabe qual bot, DB ou transporte existe.

export interface VideoJob {
  id: number;
  /**
   * 'explicativo' | 'curso' | 'demo' = skills de vídeo (HyperFrames, saída .mp4).
   * 'transcrever' | 'dublar' = delegam pro inemavox (READ-ONLY): 'transcrever' baixa+transcreve
   * localmente (Whisper) e produz TEXTO (.txt/.srt); 'dublar' baixa+dubla com IA e produz .mp4.
   * Ambos passam pela FILA (GPU-heavy: Whisper large-v3 / clonagem de voz) — nunca rodam soltos.
   */
  skill: 'explicativo' | 'curso' | 'demo' | 'transcrever' | 'dublar';
  input: string;
  /**
   * 'video' = produz 1 vídeo (default, modelo 1 job = 1 render).
   * 'plan'  = job PLANNER: o agente classifica o input, escolhe a skill, mapeia a estrutura
   *           (ex.: curso → módulos) e ENFILEIRA 1 job 'video' por peça. Não renderiza nada.
   *           Resolve o "manda a URL do curso e esquece" sem cair no P7 (1 job = 1 etapa).
   */
  kind: 'video' | 'plan';
  /** id do job 'plan' que gerou este job (NULL se foi enfileirado direto). */
  parent_id: number | null;
  /** JSON: { vertical?: boolean; dest?: string } */
  opts: string | null;
  status: 'queued' | 'running' | 'done' | 'failed' | 'canceled';
  result_path: string | null;
  error: string | null;
  notify: 'sempre' | 'silencioso';
  /** 0 | 1 — anexar o .mp4 ao terminar */
  send_video: number;
  chat_id: string | null;
  /** Rótulo do curso pra agrupar/estatísticas no painel (ex.: "skills-craft"). */
  course: string | null;
  /** Rótulo do módulo/parte (ex.: "1.1 — O que é uma Agent Skill" ou "landing"). */
  module: string | null;
  /** Caminho-alvo do .mp4 que o worker vigia no modo background+poll. */
  render_target: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface EnqueueInput {
  skill: VideoJob['skill'];
  input: string;
  opts: string | null;
  notify: VideoJob['notify'];
  sendVideo: boolean;
  chatId: string | null;
  /** Opcional: rótulo do curso pra agrupamento/estatísticas. */
  course?: string | null;
  /** Opcional: rótulo do módulo/parte. */
  module?: string | null;
  /** 'video' (default) ou 'plan' (job planner que decompõe). */
  kind?: VideoJob['kind'];
  /** Opcional: id do job planner que gerou este. */
  parentId?: number | null;
}

/** Estatísticas agregadas da fila (painel + CLI). */
export interface CourseStat {
  course: string;
  total: number;
  done: number;
  failed: number;
  running: number;
  queued: number;
  canceled: number;
}
export interface QueueStats {
  byStatus: Record<VideoJob['status'], number>;
  courses: CourseStat[];
  /** Tempo médio (s) entre started_at e finished_at dos jobs 'done'. Null se nenhum. */
  avgRenderSeconds: number | null;
  /** Jobs 'done' por hora nas últimas 24h. Null se nenhum. */
  throughputPerHour: number | null;
  /** ETA (s) pra esvaziar a fila = queued × avgRenderSeconds / concorrência. Null se desconhecido. */
  etaSeconds: number | null;
}

/**
 * Porta de persistência. Implemente sobre qualquer DB (o SQLite default vem em
 * `sqlite-store`; o openpcbot implementa sobre o SQLite dele).
 */
export interface QueueStore {
  enqueue(job: EnqueueInput): number;
  /** Próximo job 'queued' (FIFO: created_at, id) ou null. */
  getNext(): VideoJob | null;
  /** Primeiro job 'running' (compat; com concorrência >1 prefira listRunning). */
  getRunning(): VideoJob | null;
  /** Quantos jobs estão 'running' agora (trava de concorrência). */
  runningCount(): number;
  /** Todos os jobs 'running' (pra painel processando×espera). */
  listRunning(): VideoJob[];
  markRunning(id: number): void;
  /** Grava o caminho-alvo do render que o worker vai vigiar (modo background+poll). */
  setRenderTarget(id: number, target: string): void;
  markDone(id: number, resultPath: string): void;
  markFailed(id: number, error: string): void;
  /** Cancela só se ainda 'queued'. Retorna se mudou alguma linha. */
  cancel(id: number): boolean;
  list(limit?: number): VideoJob[];
  /** Estatísticas agregadas (status, por curso, médias). */
  stats(): QueueStats;
  /** No boot: marca jobs 'running' órfãos (crash/restart) como 'failed'. Retorna quantos. */
  failStaleRunning(): number;
}

/**
 * Resultado de `waitForFile` — distingue os 3 desfechos do modo background+poll:
 *   - `ok: true`                        → arquivo alvo apareceu e estabilizou (sucesso).
 *   - `ok: false, failedMarker: true`   → apareceu o marcador `<alvo>.err` ANTES do alvo:
 *     o passo destacado morreu (crash, comando falhou) — falha RÁPIDA, não espera o timeout.
 *   - `ok: false, failedMarker: false`  → nem alvo nem marcador apareceram até o timeout
 *     (processo pendurado mas vivo, ou lento demais) — o backstop de sempre.
 */
export interface WaitForFileResult {
  ok: boolean;
  failedMarker: boolean;
  /** Trecho final do log do passo destacado (`<alvo>.log`), se existir — pra diagnóstico. */
  logExcerpt?: string;
}

/** Porta de IO — efeitos colaterais específicos do host. */
export interface QueueDeps {
  /** Spawna o agente autônomo (ex.: Claude Code) com o prompt e devolve o texto final. */
  runAgent: (prompt: string) => Promise<{ text: string | null }>;
  sendMessage: (chatId: string, text: string) => Promise<void>;
  sendDocument: (chatId: string, path: string) => Promise<void>;
  /** Move o .mp4 renderizado para um destino e devolve o caminho final. */
  moveVideo: (src: string, dest: string) => Promise<string>;
  /**
   * Modo background+poll (P7): espera o arquivo de render existir e estabilizar
   * (tamanho parado por alguns segundos), OU o marcador de falha `<path>.err` aparecer
   * (o prompt do agente dispara o comando real como `<cmd> || touch "<path>.err"`, então
   * um `.err` significa que o passo destacado morreu — falha rápida em vez de esperar o
   * timeout inteiro). Default implementado no host; em testes é injetado.
   */
  waitForFile?: (path: string, opts?: { timeoutMs?: number; stableMs?: number; pollMs?: number }) => Promise<WaitForFileResult>;
}

export type ParsedCommand =
  | { ok: true; skill: VideoJob['skill']; input: string; vertical: boolean; send: boolean; silent: boolean; dest?: string; course?: string; module?: string }
  | { ok: false; error: string };

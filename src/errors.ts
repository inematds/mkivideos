// Utilitário puro de tratamento de erro — sem dependências de host (SQLite, fs, etc.)
// pra poder ser usado tanto pelo store (sqlite-store.ts) quanto pelo motor (queue.ts)
// sem o motor "puro" arrastar a implementação do SQLite junto.

/**
 * Condensa a mensagem de erro pra caber num campo limitado SEM perder a causa.
 *
 * Erro de `execFile` chega como `"Command failed: <comando>\n<stderr>"` — e às vezes o
 * comando é o prompt INTEIRO do agente (centenas de chars). O corte ingênuo (`slice(0, max)`)
 * guardava só o eco do comando e descartava o stderr, que é a única parte que explica a falha.
 * Guardamos cabeça (o que rodou) + cauda (a causa).
 */
export function condenseError(error: string, max = 2000): string {
  const s = (error ?? '').trim();
  if (s.length <= max) return s;
  const head = 200;
  const marker = '\n…[trecho do meio cortado]…\n';
  return s.slice(0, head) + marker + s.slice(-(max - head - marker.length));
}

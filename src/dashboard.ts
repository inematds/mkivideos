// Dashboard portável da fila — HTML autocontido + servidor HTTP sem dependências
// (node:http). Qualquer host pode: (a) importar só o HTML e plugar na própria rota,
// ou (b) usar createDashboardServer() pra subir um painel standalone.

import http from 'node:http';
import os from 'node:os';

import type { QueueStore } from './types.js';

/** Snapshot da máquina (CPU/load/RAM) pro painel de operação (P6). */
export interface MachineInfo {
  cpus: number;
  load1: number;
  memUsedGB: number;
  memTotalGB: number;
}
export function machineInfo(): MachineInfo {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    cpus: os.cpus().length,
    load1: Math.round(os.loadavg()[0] * 100) / 100,
    memUsedGB: Math.round(((total - free) / 1e9) * 10) / 10,
    memTotalGB: Math.round((total / 1e9) * 10) / 10,
  };
}

/** Página autocontida que faz polling de /api/video-jobs + /api/stats. token vazio = sem auth. */
export function getVideoDashboardHtml(token = ''): string {
  return `<!DOCTYPE html>
<html lang="pt-br"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fila de Vídeos — mkivideos</title>
<style>
  :root{--bg:#0D1321;--bg2:#1D2D44;--bg3:#3E5C76;--fg:#F0EBD8;--mut:#748CAB;--acc:#FFC300;--code:#2EC4B6;--red:#b00020}
  body { font-family: system-ui, sans-serif; background:var(--bg); color:var(--fg); margin:0; padding:24px; }
  h1 { color:var(--acc); font-size:20px; margin:0 0 4px; }
  h2 { color:var(--mut); font-size:13px; text-transform:uppercase; letter-spacing:.08em; margin:24px 0 8px; }
  .bar-top{display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px}
  .controls{font-size:13px; color:var(--mut)} .controls select,.controls button{background:var(--bg2);color:var(--fg);border:1px solid var(--bg3);border-radius:6px;padding:4px 8px}
  .cards{display:flex; gap:12px; flex-wrap:wrap; margin-top:12px}
  .stat{background:var(--bg2); border:1px solid var(--bg3); border-radius:10px; padding:10px 16px; min-width:96px}
  .stat .n{font-size:24px; font-weight:700} .stat .l{font-size:12px; color:var(--mut)}
  .stat.done .n{color:var(--code)} .stat.running .n{color:var(--acc)} .stat.failed .n{color:#e07a7a}
  .course{background:var(--bg2); border:1px solid var(--bg3); border-radius:10px; padding:10px 14px; margin:8px 0}
  .course .hd{display:flex; justify-content:space-between; font-size:14px}
  .prog{height:8px; background:#10203a; border-radius:5px; overflow:hidden; margin-top:6px; display:flex}
  .prog .d{background:var(--code)} .prog .r{background:var(--acc)} .prog .f{background:#e07a7a}
  table { width:100%; border-collapse:collapse; margin-top:8px; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--bg3); font-size:14px; }
  th { color:var(--mut); font-weight:600; }
  .badge { padding:2px 8px; border-radius:10px; font-size:12px; }
  .queued{background:var(--bg3)}.running{background:var(--acc);color:var(--bg)}.done{background:var(--code);color:var(--bg)}
  .failed{background:var(--red)}.canceled{background:#555}
  button { background:var(--bg2); color:var(--fg); border:1px solid var(--bg3); border-radius:6px; padding:4px 10px; cursor:pointer; }
  a { color:var(--acc); } .mut{color:var(--mut)}
</style></head><body>
<div class="bar-top">
  <div><h1>📋 Fila de Vídeos</h1><span class="mut" id="machine">—</span></div>
  <div class="controls">atualizar:
    <select id="freq" onchange="resetTimer()">
      <option value="2000">2s</option><option value="5000" selected>5s</option>
      <option value="15000">15s</option><option value="0">off</option>
    </select>
    <button onclick="load()">↻ agora</button>
  </div>
</div>

<div class="cards" id="stats"></div>

<h2>Por curso</h2>
<div id="courses"><span class="mut">—</span></div>

<h2>Processando agora</h2>
<table><thead><tr><th>#</th><th>Curso / módulo</th><th>Entrada</th><th>Alvo</th></tr></thead>
<tbody id="running"><tr><td colspan="4" class="mut">—</td></tr></tbody></table>

<h2>Fila + histórico</h2>
<table><thead><tr><th>#</th><th>Curso</th><th>Skill</th><th>Entrada</th><th>Status</th><th>Resultado</th><th></th></tr></thead>
<tbody id="rows"><tr><td colspan="7" class="mut">carregando…</td></tr></tbody></table>

<script>
const TOKEN = ${JSON.stringify(token)};
const qs = TOKEN ? ('?token=' + encodeURIComponent(TOKEN)) : '';
let timer = null;
function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function dur(s){ if(s==null) return '—'; s=Math.round(s); const h=Math.floor(s/3600),m=Math.floor((s%3600)/60); return h?h+'h'+m+'m':(m?m+'m':s+'s'); }

async function loadStats(){
  try{
    const r = await fetch('/api/stats' + qs); const d = await r.json();
    const s = d.stats, mc = d.machine;
    document.getElementById('machine').textContent =
      mc ? ('🖥️ ' + mc.cpus + ' núcleos · load ' + mc.load1 + ' · RAM ' + mc.memUsedGB + '/' + mc.memTotalGB + 'GB') : '';
    const bs = s.byStatus;
    document.getElementById('stats').innerHTML =
      card('running', bs.running, 'rodando') + card('queued', bs.queued, 'na fila') +
      card('done', bs.done, 'prontos') + card('failed', bs.failed, 'falhas') +
      card('', s.throughputPerHour==null?'—':s.throughputPerHour, 'vídeos/h') +
      card('', dur(s.etaSeconds), 'ETA fila') + card('', dur(s.avgRenderSeconds), 'médio/vídeo');
    document.getElementById('courses').innerHTML = (s.courses||[]).map(courseRow).join('') || '<span class="mut">sem curso rotulado</span>';
    const run = d.running||[];
    document.getElementById('running').innerHTML = run.length ? run.map(function(j){
      return '<tr><td>#'+j.id+'</td><td>'+esc(j.course||'—')+' '+esc(j.module||'')+'</td><td>'+esc((j.input||'').slice(0,40))+'</td><td class="mut">'+esc(j.render_target||'—')+'</td></tr>';
    }).join('') : '<tr><td colspan="4" class="mut">nada rodando</td></tr>';
  }catch(e){ /* mantém última view */ }
}
function card(cls,n,l){ return '<div class="stat '+cls+'"><div class="n">'+esc(n)+'</div><div class="l">'+esc(l)+'</div></div>'; }
function courseRow(c){
  const t=c.total||1, pd=(c.done/t*100), pr=(c.running/t*100), pf=(c.failed/t*100);
  return '<div class="course"><div class="hd"><b>'+esc(c.course)+'</b><span class="mut">'+c.done+'/'+c.total+' feito'
    +(c.running?' · '+c.running+' rodando':'')+(c.queued?' · '+c.queued+' na fila':'')+(c.failed?' · '+c.failed+' falha':'')+'</span></div>'
    +'<div class="prog"><i class="d" style="width:'+pd+'%"></i><i class="r" style="width:'+pr+'%"></i><i class="f" style="width:'+pf+'%"></i></div></div>';
}
async function load() {
  await loadStats();
  const r = await fetch('/api/video-jobs' + qs);
  const { jobs } = await r.json();
  document.getElementById('rows').innerHTML = jobs.map(function(j){
    var inp = esc((j.input||'').length > 44 ? j.input.slice(0,44)+'…' : (j.input||''));
    var res = j.result_path ? esc(j.result_path) : (j.error ? ('⚠ '+esc(j.error)) : '—');
    var btn = j.status === 'queued' ? '<button onclick="cancelJob('+j.id+')">cancelar</button>' : '';
    return '<tr><td>#'+j.id+'</td><td class="mut">'+esc(j.course||'')+'</td><td>'+esc(j.skill)+'</td><td>'+inp+'</td>'
      + '<td><span class="badge '+esc(j.status)+'">'+esc(j.status)+'</span></td><td>'+res+'</td><td>'+btn+'</td></tr>';
  }).join('') || '<tr><td colspan="7" class="mut">Sem jobs ainda.</td></tr>';
}
async function cancelJob(id){ await fetch('/api/video-jobs/'+id+'/cancel' + qs, {method:'POST'}); load(); }
function resetTimer(){ if(timer) clearInterval(timer); const f=Number(document.getElementById('freq').value); if(f>0) timer=setInterval(load, f); }
load(); resetTimer();
</script></body></html>`;
}

export interface DashboardServerOptions {
  /** Se passado, o server já dá listen nessa porta. */
  port?: number;
  /** Se setado, exige ?token=… em todas as rotas. */
  token?: string;
}

/**
 * Servidor HTTP standalone (sem deps): serve `/videos`, `GET /api/video-jobs`,
 * `GET /api/stats`, `POST /api/video-jobs/:id/cancel`. Retorna o http.Server (chame
 * .listen se não passar `port`). Hosts com framework próprio podem usar só o HTML.
 */
export function createDashboardServer(store: QueueStore, opts: DashboardServerOptions = {}): http.Server {
  const token = opts.token ?? '';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');

    if (token && url.searchParams.get('token') !== token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/videos') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getVideoDashboardHtml(token));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/video-jobs') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jobs: store.list() }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stats: store.stats(), machine: machineInfo(), running: store.listRunning() }));
      return;
    }

    const cancelMatch = url.pathname.match(/^\/api\/video-jobs\/(\d+)\/cancel$/);
    if (req.method === 'POST' && cancelMatch) {
      const ok = store.cancel(Number(cancelMatch[1]));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  if (opts.port) server.listen(opts.port);
  return server;
}

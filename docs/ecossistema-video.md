# Ecossistema de criação de vídeo (INEMA / Nei)

> **O que é isto:** mapa dos projetos e skills que produzem vídeo no ambiente do Nei.
> A fila `/mkivideos` (este repo) hoje orquestra só **3** deles, mas o universo real é
> bem maior. Qualquer **hub / UI / fila unificada** de vídeo deve contemplar esta lista.
>
> Última atualização: 2026-06-07. Itens marcados *(a confirmar)* têm mapeamento incerto
> de pasta/escopo — verificar antes de referenciar em código.

---

## Visão geral

```
                ┌──────────────────────────────────────────────┐
                │   ASSUNTO / LINK / IMAGEM / CURSO / PRODUTO   │
                └───────────────────────┬──────────────────────┘
                                        │
        ┌───────────────┬───────────────┼───────────────┬────────────────┐
        ▼               ▼               ▼               ▼                ▼
  explicativo      demonstrativo   curso-inema     plan-editor        mdd
  (conceito)       (app real)      (aula/módulo)   (alta perf.)    (storyboard→IA)
        │               │               │               │                │
        ▼               ▼               ▼               ▼                ▼
  pixflow (img→filme) · remotion (React) · videoprodutor (orquestra) · seedance (loop)
        │
        ▼
   ┌─────────────────────────────────────────┐
   │  FILA /mkivideos (1 por vez, FIFO)       │  ← hoje cobre explicativo/curso/demo
   │  Telegram · Dashboard · CLI · standalone │
   └─────────────────────────────────────────┘
```

---

## A) Skills de geração/edição de vídeo (Claude Code)

| Skill | O que faz | Stack / saída |
|---|---|---|
| **video-explicativo** | vídeo explicativo de um **conceito** (1º princípio→avançado), narrado, motion graphics dark premium, CTA INEMA.CLUB | HTML→MP4 (HyperFrames) + TTS local · 16:9 e 9:16 |
| **video-demonstrativo** | **walkthrough** de um app web real: navega, captura telas, cursor animado que clica, zoom | HyperFrames + browser automation · 16:9 |
| **videos-cursos-inema** | vídeos de um **curso INEMA** em 3 partes: landing, trilhas, conteúdo profundo por módulo | HTML→MP4 (HyperFrames) · voz inemavox |
| **video-plan-editor** | **plano** de vídeo de alta performance (estratégia viral + linguagem de câmera) → `plano-edicao.json` + `RESUMO.md`; render opcional | plano + HyperFrames + b-roll flux2-klein |
| **mestre-direcao-dinamica** (mdd) | **storyboard + prompt** de vídeo para geradores IA (Seedance/Kling/Runway/Veo/Luma): cartão, cena, faixa do diretor, prompt final/negativo | prompts (não renderiza) |
| **pixflow-motion** (pixflow) | **imagem → filme** cinematográfico: parallax 2.5D + grain/LUT/bloom, **sem IA** (determinístico) | Depth-Anything-V2 → Three.js/WebGL → Remotion → FFmpeg |
| **remotion** / **remotion-best-practices** | criação de vídeo em **React** (Remotion) — boas práticas e componentes | Remotion |
| **videoprodutor** | skill **"Orquestrador"** de produção de vídeo | (orquestração) |
| **seedance-loop-prompt** | prompt de **vídeo em loop** (background de site) para Seedance | prompt |

## B) Projetos (repos) de vídeo / cinema

| Projeto (`~/projetos/…`) | O que é |
|---|---|
| **promptfilmes** | "🎬 Prompt Director — Imagens e Cinema com IA" |
| **promptprof** | prompts/roteiros (subpastas tipo `hormozi-12`, `kairoboost`) — copy/marketing-vídeo *(a confirmar escopo)* |
| **fontefilm** (o "fontfilm" citado) | projeto de film *(a confirmar escopo)* |
| **fpfilmv1** | film + `curso`/`doc`/`index.html` *(a confirmar — pode ser landing/curso)* |
| **remotion** / **remotion-templates** / **remotion-test** | templates e experimentos Remotion ("Remotion Templates by RVE") |
| **videoprodutor** | repo do orquestrador "videoprodutor — o Orquestrador" |

## C) Marketing — times de agentes que também produzem vídeo

| Projeto | O que é |
|---|---|
| **timesmkt**, **timesmkt2**, **timesmkt3** (+ `timesmkt3-setup`) | "Time de Agentes de Marketing" (gera conteúdo, inclui vídeo) |
| **imkt4** | "timesmkt3 v4.5" |
| **imkt5** | evolução do time de marketing |

---

## Onde a fila `mkivideos` entra (e o que falta)

- **Hoje:** a fila `/mkivideos` ([README](../README.md)) orquestra **3 skills** —
  `explicativo`, `curso`, `demo` — com concorrência = 1, Telegram, dashboard e CLI.
- **O ecossistema é maior:** as demais skills/projetos acima também produzem vídeo, com
  entradas diferentes (assunto, link, imagem, curso, produto) e stacks diferentes
  (HyperFrames, Remotion, geradores IA, parallax sem IA).
- **Implicação de design:** um **hub/UI/fila unificada** ou uma **"biblioteca de vídeos"**
  não deve assumir "vídeo = as 3 skills da fila". O motor `mkivideos` já é host-agnóstico
  (ports & adapters) — dá pra estender o `skill` da fila e o `buildVideoPrompt` para cobrir
  mais geradores, ou ter adaptadores por tipo de pipeline.

## Próximos passos possíveis (não decididos)

- Mapear/confirmar escopo e caminhos exatos de `promptprof`, `fontefilm`, `fpfilmv1`.
- Padronizar a **saída** (`renders/<nome>.mp4`) entre todos, pra uma biblioteca única.
- Estender a fila para aceitar mais tipos (`pixflow`, `remotion`, `mdd→gerador IA`).
- UI "Biblioteca de vídeos": listar/preview/mover/publicar os `.mp4` de todas as fontes.

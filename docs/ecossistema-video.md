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

## B) Orquestrador do ecossistema

| Projeto (`~/projetos/…`) | O que é |
|---|---|
| **videoprodutor** | 🎯 **"O Produtor / Orquestrador".** Entra **um link/fonte** → sai **plano + execução** de um vídeo profissional, ponta a ponta. Não refaz render/geração: **coordena as peças que já existem** (planejamento, direção, prompt, imagem, voz, render) numa linha de montagem, com **Remotion** como motor unificado (camada cinema do pixflow + 54 componentes do remotion-templates). O próprio README diz: *"~11 skills e 6 motores de vídeo espalhados, ~70% da fábrica já existe"* — é o **hub unificado** do ecossistema (ver `videoprodutor/docs/01`). |

> ⚠️ **Overlap importante:** o `videoprodutor` já é a tentativa de hub/orquestração de
> vídeo. Qualquer trabalho de "fila/UI unificada" deve **partir dele**, não competir.

## C) Motores (repos) que CRIAM vídeo

| Projeto | O que é |
|---|---|
| **fontefilm** (o "fontfilm" citado) | 🎬 **Diretor de cinema IA, local.** texto + estilo → roteiro (3 atos) → bíblia (personagens/locações/paleta) → decupagem (plano+câmera por painel) → imagens → narração → montagem → **vídeo final** (estilo quadrinhos; teoria de transições do Scott McCloud). O "cérebro de direção" é o diferencial. |
| **remotion** / **remotion-templates** / **remotion-test** | Motor/templates de vídeo em **React (Remotion)** — "Remotion Templates by RVE", 54 componentes; base de render do `videoprodutor`. |

## D) Cursos sobre criação de vídeo/imagem (educacionais, INEMA.CLUB — NÃO são ferramentas)

| Projeto | O que é |
|---|---|
| **promptfilmes** | 📚 Curso **"Prompt Director — Imagens e Cinema com IA"**: prompts visuais p/ Midjourney v7, Sora 2, Veo 3, Runway Gen-4, Flux, Nano Banana, Seedance 2, Kling 2.5… 4 trilhas, 19 módulos, 24 páginas. [inematds.github.io/promptfilmes](https://inematds.github.io/promptfilmes/) |
| **fpfilmv1** | 📚 Curso **"Freepik Film \| INEMA.CLUB"** — trilhas 1–6 sobre fazer filme com as ferramentas de IA da Freepik. |

## E) Projetos de trabalho / marketing (geram vídeo como entregável)

| Projeto | O que é |
|---|---|
| **promptprof** | 🗂️ Área de trabalho de **marketing + planejamento de vídeo**: subpastas `hormozi-12` (com `MDD-PACKAGE.md`, `plano-edicao.json`, `RESUMO.md`, `video/`) e `kairoboost` (`presets.md`, `SYSTEM-PROMPT.md`, `vocabulario.md`). Consome mdd + video-plan-editor. |

## F) Marketing — times de agentes que também produzem vídeo

| Projeto | O que é |
|---|---|
| **timesmkt**, **timesmkt2**, **timesmkt3** (+ `timesmkt3-setup`) | "Time de Agentes de Marketing" (gera conteúdo, inclui vídeo) |
| **imkt4** | "timesmkt3 v4.5" |
| **imkt5** | evolução do time de marketing |

---

## G) Motores / formatos de render

Quem efetivamente transforma a "receita" em `.mp4`:

| Motor | O que é | Quem usa |
|---|---|---|
| **HyperFrames** | HTML + GSAP → MP4 (Chrome headless + FFmpeg). Sem chave de API, local. | video-explicativo, video-demonstrativo, videos-cursos-inema |
| **Remotion** | vídeo programático em **React** → MP4 | remotion, pixflow, videoprodutor |
| **pixflow** | parallax 2.5D **determinístico** (sem IA): Depth-Anything-V2 → Three.js/WebGL → Remotion → FFmpeg | pixflow-motion |
| **FFmpeg** | encode/concat/trim; **NVENC** (GPU) no encode | base de todos |
| **Canvas + frames** | extração de frames + render em canvas (scroll-driven) | 3d-animation-creator |

## H) Geradores de vídeo por IA (prompt → clipe)

Recebem um **prompt** (cartão de cena, câmera, ação) e geram o clipe. Dividem-se em:

- **Cloud:** **Seedance · Kling · Runway (Gen-4) · Veo · Luma · Sora.**
- **Local / self-hosted (no DGX):** **SkyReels V3** (`~/projetos/skyreelsv3` — fork do modelo SkyReels
  V3 com integração própria). Roda na própria máquina, sem depender de API externa.

A skill **mestre-direcao-dinamica (mdd)** monta o storyboard + prompt/negativo pra esses geradores;
**seedance-loop-prompt** foca em vídeo de **loop** (background de site).

## J) Infra — VideosDGX (rodar modelos de vídeo no DGX)

**`~/projetos/VideosDGX`** — "Docker Multi-Container para Video LLMs": infraestrutura containerizada
pra **rodar modelos de geração de vídeo no DGX Spark** (ex.: SkyReels e outros). É a camada de
**infra/orquestração de containers** dos geradores locais — onde os modelos da seção H (local) rodam.

## I) Apoio — voz (TTS) e imagem (b-roll)

| Tipo | Opções |
|---|---|
| **Voz (TTS)** | **inemavox** (`bella`/`rachel`, vozes clonadas locais — default) · **Kokoro** (`pf_dora`/`pm_alex`, local grátis) · **ElevenLabs** (cloud, precisa key) |
| **Imagem / b-roll** | **flux2-klein** (default de imagem) · **NanoBanana** · **inemaimg** (serviço local de geração, `localhost:8000`) |
| **Upscale de imagem** | **inemaupsk** (upscaler local, `localhost:8002`) |

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

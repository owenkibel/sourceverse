# Gramarye

**Gramarye** is an experimental system for generating long-form oracular narrative. It transforms streams of current events, scientific developments, and political signals into sustained story arcs, metrical verse, and forward-looking forecasts.

The project explores how **persistent memory** and pattern recognition can produce coherent, evolving narratives across multiple cycles rather than isolated posts.

The code is evolved through iterative testing of scripts that emerge out of directed and continuing conversations with the latest Gemini and Grok models in their regular portals. These models are also directly addressed in the scripts through their APIs.

## Core Ideas

- **Persistent Narrative Memory**: A cumulative model (`cumulative_thread_model.json`) maintains domain-specific narrative arcs, recent forecasts, and hypothesis history. This allows the system to build continuity across runs.
- **Oracular Output**: In addition to verse and media, the system generates optional forecasts that attempt to read momentum, thresholds, and phase shifts.
- **Dual Artistic Modes**: Supports both *dramatic* (character-driven theatrical verse) and *traditional* (unified lyrical voice) styles.
- **Hybrid Content**: Designed to host both AI-generated oracular posts and human-written writing.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) (recommended) or Node.js
- API access to **Grok** (xAI) and/or **Gemini** (Google)
- (Optional) A running instance of **ComfyUI** for local image/video/music generation

### Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/owenkibel/sourceverse.git
   cd sourceverse
   ```

2. Install dependencies:

   ```bash
   bun install
   ```

3. Set your API keys as environment variables:

   ```bash
   export XAI_API_KEY=your_xai_key
   export GEMINI_API_KEY1=your_gemini_key
   ```

### Running the Pipeline

The main workflow uses two scripts:

- **`generate-links*.js`** — Ingests bookmarks or URLs and creates initial thematic groupings.
- **`vertical_thread7.js`** — The core script that generates narrative arcs, verse, forecasts, and media.

**Example run:**

```bash
bun vertical_thread7.js --grok --ideogram --thread=t4
```

### Common Flags

| Flag                | Description                                      | Example |
|---------------------|--------------------------------------------------|--------|
| `--grok`            | Use Grok-4.3 instead of Gemini                   | `--grok` |
| `--ideogram`        | Use Ideogram 4 for image generation              | `--ideogram` |
| `--grok-imagine`    | Use Grok’s native image generation              | `--grok-imagine` |
| `--thread=t4`       | Process only a specific thread folder            | `--thread=t4` |
| `--t2v`             | Force text-to-video instead of image-to-video    | `--t2v` |
| `--duration=180`    | Set music duration in seconds                    | `--duration=180` |

## Key Features

- Long-running narrative continuity via `narrativeArcs[domain]`
- Optional `### Forecast` sections grounded in the current thread
- Canonical hypothesis system with deduplication and cooldown logic
- Support for both dramatic and traditional verse
- Forecast lifecycle tracking (processed / appended / injected)
- Thematic Seed section (original short poem from the ingestion stage)

## Pipeline Overview

1. **Ingestion** — `generate-links*.js` processes Chrome bookmarks or specific URLs and produces an initial thematic summary/poem.
2. **Vertical Processing** — `vertical_thread7.js` runs candidate threads through structured prompts using Grok or Gemini.
3. **Persistent State** — Narrative arcs, forecasts, and hypotheses are read from and written to `cumulative_thread_model.json`.
4. **Media Generation** — Images, video, TTS, and music are generated and embedded in the output.
5. **Output** — Clean Markdown posts ready for a static site.

## Scripts

| Script                    | Purpose                                      | Example Command |
|---------------------------|----------------------------------------------|-----------------|
| `generate-links*.js`      | Thematic grouping + initial poem from bookmarks/URLs | `bun generate-links2.js` |
| `vertical_thread7.js`     | Main orchestration (narrative, verse, media, state) | `bun vertical_thread7.js --grok --ideogram --thread=t4` |
| `cleanup_*.js`            | Maintenance (hypothesis pruning, model cleanup) | — |

## Persistent Memory

Gramarye maintains continuity through `cumulative_thread_model.json`. Each domain keeps its own evolving narrative arc and recent forecast history. This allows later posts to reference and build upon earlier ones rather than starting from scratch.

## Blog

The output is published at [Gramarye](https://gramarye.vercel.app/).

The blog supports both AI-generated oracular posts and human-written contributions.

## Philosophy

Gramarye treats current events as signals within larger patterns. It attempts to maintain living narrative threads that can surface thresholds, phase shifts, and latent forces over time.

The system combines large language model generation with explicit persistent memory and structured prompt engineering.

## Status

This is an active research project. The architecture continues to evolve around better long-term coherence, more grounded forecasting, and a cleaner relationship between raw input and expanded oracular output. A previous version without persistent memory is at 
[sourceverse0](https://github.com/owenkibel/sourceverse0).

## Links

- **Blog**: [Gramarye](https://gramarye.vercel.app/)
- **Repository**: [sourceverse](https://github.com/owenkibel/sourceverse)
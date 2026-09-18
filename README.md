# Sourceverse

Sourceverse turns a slice of current pages — Chrome bookmarks, X posts, articles, the occasional video — into **metrical verse, a continuing thread, and media**. The live site is [Latent Verse](https://latent-verse.vercel.app/).

The main loop is two scripts: ingest, then grow a thread with picture, optional video, music, and a forecast. A separate, smaller experiment grows **prose courses and voice rewrites** from the same kind of URL. Those posts also land on Latent Verse; they do not replace the poetry pipeline.

Scripts are numbered as they evolve (`generate-links7.js`, `vertical_thread17.js`). Use the highest version in the repo.

## Main workflow: poetry, media, threads

```
bookmarks / URLs
        │
        ▼
 generate-links*.js     thematic groups + seed poem → ./x  and posts/
        │
        ▼
 vertical_thread*.js    arc + verse + forecast + image/video/music
        │
        ▼
  posts/  →  Astro site  →  https://latent-verse.vercel.app/
```

Persistent thread memory lives in `cumulative_thread_model.json` (narrative arcs, hypotheses, forecast history). That file is for **threads only**. Course memory is a different file.

### Ingest

`generate-links*.js` takes a batch of recent bookmarks (default 40) or a single `--url=`. It can drop music and Imagine links with `--ignore`. X posts try the public fx/vx JSON APIs first; Playwright stays further down the cascade. YouTube English auto-captions use local `yt-dlp`.

```bash
bun generate-links7.js --ignore music imagine
bun generate-links7.js --url="https://x.com/user/status/..." --grok
```

### Grow a thread

`vertical_thread*.js` reads a folder under `./x`, writes verse (dramatic or traditional), updates the cumulative thread model, and talks to ComfyUI / Ideogram / Grok Imagine for stills and video. Audio is stitched with ffmpeg (reverse-to-anchor on short clips, still-image fallback).

```bash
bun vertical_thread17.js --grok --thread=t4
bun vertical_thread17.js --grok --grok-imagine --thread=t4
bun vertical_thread17.js --grok --ideogram --t2v --duration=128 --thread=t4
```

If Grok refuses the verse pass, current builds abort immediately and print the reason. They do not generate media on an empty string.

### Typical flags

| Flag | What it does |
|---|---|
| `--grok` | xAI instead of Gemini |
| `--thread=t4` | One `./x` folder |
| `--grok-imagine` / `--ideogram` | Image backend |
| `--t2v` | Text-to-video instead of image-to-video |
| `--duration=128` | Music length in seconds |
| `--ignore music imagine` | generate-links: skip those hosts |

## Setup

- [Bun](https://bun.sh/)
- `XAI_API_KEY` and/or `GEMINI_API_KEY1`
- Optional: ComfyUI, llama.cpp, `ffmpeg`, `yt-dlp`, Playwright for stubborn X pages

```bash
git clone https://github.com/owenkibel/sourceverse.git
cd sourceverse
bun install
export XAI_API_KEY=...
```

The Astro blog lives in `site/`. Generated Markdown in `posts/` is what [Latent Verse](https://latent-verse.vercel.app/) shows.

## Courses and rewrites (experiment)

A second memory, `cumulative_course_model.json`, stores **series** (Demagoguery 101, Snark 101, Humor 101, Satire 101, Black 101, Devine 101, …). Each run adds one layer and compresses a system prompt. No ComfyUI; output is prose modules and later rewrites.

This is optional. Most bookmarks should stay in generate-links / vertical_thread.

**Train a desk** (point at one article or a long X note):

```bash
bun course_builder5.js --url="https://..." --title="Black 101" --mode=prompt
bun course_builder5.js --url="https://..." --title="Devine 101" --mode=course
```

`--mode=prompt` grows a **craft** kit (how the desk writes). `--mode=course` grows an **analyst** kit (how to diagnose the pattern). Humor and satire are their own modes. `--reset` clears only that series in the JSON; delete `courses/<slug>/` if you want the markdown gone too.

**Rewrite a neutral page in a trained voice:**

```bash
bun voice_rewrite.js --url="https://apnews.com/..." --title="Devine 101" --as=analyst
bun voice_rewrite.js --url="https://x.com/user/status/..." --title="Black 101" --as=craft
bun voice_rewrite.js --url="https://..." --title="Humor 101" --as=humor
```

`--as=` is `craft | analyst | humor | satire`. Official fact sheets and short agency tweets belong to **analyst** or skip; they will not produce a signed column. YouTube URLs pull English auto-captions as spoken source.

**Optional helpers**

```bash
bun list-bookmarks.js --n=24 --ignore=music --ignore=imagine --out=urls.txt
bun classify-slice.js --file=urls.txt
```

`classify-slice` makes one taxonomy call and stamps `--title` / `--as`. Almost every URL should come back `skip`. It does not write posts.

## Memory (do not mix)

| File | Used by |
|---|---|
| `cumulative_thread_model.json` | generate-links / vertical_thread |
| `cumulative_course_model.json` | course_builder / voice_rewrite (read-only in rewrite) |

Course prompts are stored as `courses/<slug>/_prompt.md` (underscore so Astro does not glob them as posts). Published rewrites go to `posts/` only with `--publish`.

## Related

- Limericks: [Fifth Line](https://fifth-line.grok.me/) ([repo](https://github.com/owenkibel/fifth-line)), [Gemini edition](https://fifth-line-gemini.vercel.app/) ([repo](https://github.com/owenkibel/fifth-line-gemini))
- Earlier system: [Groetry](https://groetry.pages.dev) / [sourceverse0](https://github.com/owenkibel/sourceverse0)

## Status

Active. The poetry + media thread is the product. Courses and rewrites are a prose experiment on the same bookmark stream. Script names increment as the conversation that maintains them does.

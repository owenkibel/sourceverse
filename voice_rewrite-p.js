#!/usr/bin/env bun
/**
 * voice_rewrite.js
 *
 * Separate from course_builder. Does not touch course memory except as
 * a read-only prompt source. Takes a neutral/factual URL and rewrites
 * it using a prompt grown by course_builder3/4.
 *
 * Prompt resolution order:
 *   1. --prompt-file=path/to/_prompt.md
 *   2. courses/<slug>/_prompt.md  (from --title / --from)
 *   3. cumulative_course_model.json field for that series
 *
 * Usage:
 *   bun voice_rewrite.js --url="https://apnews.com/..." --title="Snark 101"
 *   bun voice_rewrite.js --url="https://..." --from=satire-101
 *   bun voice_rewrite.js --url="https://..." --prompt-file=courses/humor-101/_prompt.md
 *   bun voice_rewrite.js --url="https://..." --title="Demagoguery 101" --as=analyst
 *
 * --as=  craft | analyst | humor | satire | auto
 *        auto uses series.lastPromptKind, then first non-empty stored prompt
 *
 * Writes:
 *   rewrites/<series-slug>/<stamp>.md
 *   posts/ only with --publish
 *
 * Astro-safe front matter. Tags: Rewrite + series slug (+ voice kind).
 */

import fs from 'fs/promises';
import path from 'path';
import ogs from 'open-graph-scraper';

const MODEL_PATH = 'cumulative_course_model.json';
const COURSES_DIR = 'courses';
const REWRITES_DIR = 'rewrites';
const POSTS_DIR = 'posts';
const DEFAULT_MODEL = process.env.XAI_MODEL || 'grok-4.6';
const SOURCE_CHAR_CAP = 10000;

const args = process.argv.slice(2);
const urlArg = args.find((a) => a.startsWith('--url='))?.slice(6);
const titleArg =
  args.find((a) => a.startsWith('--title='))?.slice(8) ||
  args.find((a) => a.startsWith('--course='))?.slice(9);
const fromArg = args.find((a) => a.startsWith('--from='))?.slice(7);
const promptFileArg = args.find((a) => a.startsWith('--prompt-file='))?.slice(14);
const asArg = (args.find((a) => a.startsWith('--as='))?.slice(5) || 'auto').toLowerCase();
const publish = args.includes('--publish');
const dryRun = args.includes('--dry-run');

const FIELD_FOR = {
  craft: 'craftPrompt',
  analyst: 'analystPrompt',
  humor: 'humorPrompt',
  satire: 'satirePrompt',
};

function slugify(t) {
  return (t || '')
    .toString()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

function yamlString(value) {
  return JSON.stringify(value == null ? '' : String(value));
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function enrichUrl(url) {
  let title = url;
  let description = '';
  let body = '';
  try {
    const { result, html } = await ogs({ url, timeout: 15000 });
    title = result?.ogTitle || result?.twitterTitle || title;
    description = result?.ogDescription || result?.twitterDescription || '';
    if (html) {
      const article = html.match(/<article[\s\S]*?<\/article>/i)?.[0] || html;
      body = stripHtml(article);
    }
  } catch (err) {
    console.warn(`  OGS failed (${err.message}). Falling back to fetch.`);
  }
  if (!body || body.length < 200) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 Sourceverse-voice-rewrite' },
      });
      const html = await res.text();
      if (!title || title === url) {
        title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || title;
      }
      body = stripHtml(html);
    } catch (err) {
      console.warn(`  Fetch fallback failed: ${err.message}`);
    }
  }
  let combined = [description, body].filter(Boolean).join('\n\n').trim();
  if (combined.length > SOURCE_CHAR_CAP) {
    combined = combined.slice(0, SOURCE_CHAR_CAP) + '\n\n[Source truncated]';
  }
  return { url, title, description, text: combined || '[No extractable text]' };
}

function extractPromptFromMarkdown(md) {
  const text = String(md || '').replace(/^---[\s\S]*?---\s*/, '');
  const parts = text.split(/^## Prompt\s*$/m);
  if (parts.length < 2) return text.trim();
  const after = parts.slice(1).join('## Prompt\n');
  const cut = after.split(/^## /m)[0];
  return cut.trim();
}

async function loadSeries(slug) {
  try {
    const raw = JSON.parse(await fs.readFile(MODEL_PATH, 'utf8'));
    const series = (raw.series || raw.courses || {})[slug];
    return series || null;
  } catch {
    return null;
  }
}

async function resolveVoice({ slug, seriesTitle }) {
  if (promptFileArg) {
    const md = await fs.readFile(promptFileArg, 'utf8');
    const prompt = extractPromptFromMarkdown(md);
    return {
      kind: asArg === 'auto' ? 'craft' : asArg,
      prompt,
      origin: promptFileArg,
      seriesTitle: seriesTitle || slug,
      slug,
    };
  }

  const series = slug ? await loadSeries(slug) : null;
  let kind = asArg;
  if (kind === 'auto') {
    kind = series?.lastPromptKind || '';
    if (!kind || !series?.[FIELD_FOR[kind]]) {
      kind = ['craft', 'satire', 'humor', 'analyst'].find((k) => series?.[FIELD_FOR[k]]) || 'craft';
    }
  }

  const field = FIELD_FOR[kind];
  let prompt = (series && field && series[field]) || '';

  if (!prompt && slug) {
    const hidden = path.join(COURSES_DIR, slug, '_prompt.md');
    const pub = path.join(COURSES_DIR, slug, 'prompt.md');
    for (const candidate of [hidden, pub]) {
      try {
        prompt = extractPromptFromMarkdown(await fs.readFile(candidate, 'utf8'));
        if (prompt) {
          return {
            kind,
            prompt,
            origin: candidate,
            seriesTitle: series?.title || seriesTitle || slug,
            slug,
          };
        }
      } catch {
        /* next */
      }
    }
  }

  if (!prompt) {
    throw new Error(
      `No ${kind} prompt found for ${slug || '(no series)'}. Run course_builder first or pass --prompt-file.`
    );
  }

  return {
    kind,
    prompt,
    origin: `${MODEL_PATH}:${field}`,
    seriesTitle: series?.title || seriesTitle || slug,
    slug,
  };
}

function guardrailFor(kind) {
  if (kind === 'analyst') {
    return 'Write an analysis of the source using the course mechanisms. Do not produce a speech that performs the pattern. Do not invent facts.';
  }
  if (kind === 'humor') {
    return 'Rewrite as comic observation. Do not attack persons as villains. Do not invent facts. Keep named facts from the source.';
  }
  if (kind === 'satire') {
    return 'Rewrite as satire aimed at institutions, incentives, or official language. Do not invent incidents. Do not write instructions for harm.';
  }
  return 'Rewrite in the learned desk voice. Do not invent quotations or facts not in the source. Mark uncertainty rather than fabricating color.';
}

async function callGrok(system, user) {
  if (!process.env.XAI_API_KEY) throw new Error('XAI_API_KEY is required');
  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.XAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: kindTemperature(system),
      max_tokens: 4096,
      reasoning_effort: 'low',
    }),
  });
  if (!response.ok) throw new Error(`xAI API ${response.status}: ${await response.text()}`);
  const data = await response.json();
  const msg = data.choices?.[0]?.message;
  return (msg?.content || msg?.reasoning_content || '').trim();
}

function kindTemperature(system) {
  if (/HUMOR/i.test(system)) return 0.75;
  if (/SATIRE|CRAFT|desk/i.test(system)) return 0.7;
  return 0.45;
}

function buildRewriteMarkdown({ voice, source, body, now }) {
  const title = `${source.title} — ${voice.kind} rewrite`;
  const day = now.split('T')[0];
  const tags = ['Rewrite', voice.slug, voice.kind].filter(Boolean);
  const tagLines = tags.map((t) => `  - ${yamlString(t)}`).join('\n');
  return `---
title: ${yamlString(title)}
author: "Grok"
date: "${now}"
pubDate: "${day}"
description: ${yamlString(`${voice.kind} rewrite via ${voice.seriesTitle}`)}
tags:
${tagLines}
type: "rewrite"
source: ${yamlString(source.url)}
---

# ${title}

Voice: **${voice.seriesTitle}** (${voice.kind})
Original: [${source.title}](${source.url})

${body}
`;
}

async function main() {
  if (!urlArg) {
    console.error('Required: --url="https://..." plus --title, --from, or --prompt-file');
    process.exit(1);
  }

  const seriesTitle = (titleArg || '').trim();
  const slug = slugify(fromArg || seriesTitle || 'voice');
  const voice = await resolveVoice({ slug, seriesTitle: seriesTitle || fromArg });

  console.log(`\n✒️  Voice rewrite`);
  console.log(`   Voice  : ${voice.seriesTitle} (${voice.kind})`);
  console.log(`   Prompt : ${voice.origin}`);
  console.log(`   URL    : ${urlArg}`);

  const source = await enrichUrl(urlArg);
  console.log(`   Source : ${source.title} (${source.text.length} chars)`);

  const system = `${voice.prompt}

ADDITIONAL CONSTRAINTS
${guardrailFor(voice.kind)}
Write a complete piece, not a bullet inventory of techniques.
Do not include a techniques ledger or course headers.`;

  const user = `Rewrite the following source.

Title: ${source.title}
URL: ${source.url}

SOURCE TEXT:
${source.text}`;

  if (dryRun) {
    console.log('\n🧪 --dry-run: voice resolved, no API call.');
    console.log(voice.prompt.slice(0, 400));
    return;
  }

  console.log(`\n🧠 Rewriting with ${DEFAULT_MODEL}...`);
  const body = await callGrok(system, user);
  const now = new Date().toISOString();
  const md = buildRewriteMarkdown({ voice, source, body, now });

  const outDir = path.join(REWRITES_DIR, voice.slug || 'voice');
  await fs.mkdir(outDir, { recursive: true });
  const stamp = now.replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `${stamp}.md`);
  await fs.writeFile(outPath, md, 'utf8');
  console.log(`✅ ${outPath}`);

  if (publish) {
    await fs.mkdir(POSTS_DIR, { recursive: true });
    const postName = `${slugify(source.title).slice(0, 40)}-${voice.kind}-${Date.now()}.md`;
    const postPath = path.join(POSTS_DIR, postName);
    await fs.writeFile(postPath, md, 'utf8');
    console.log(`✅ published ${postPath}`);
  }
}

main().catch((err) => {
  console.error('Fatal voice_rewrite error:', err);
  process.exit(1);
});

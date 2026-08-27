#!/usr/bin/env bun
/**
 * course_builder3.js
 *
 * Isolated from vertical_thread / cumulative_thread_model.json.
 *
 * Both series now grow a prompt:
 *   --mode=course  analyst prompt  (diagnose the pattern; continue the course)
 *   --mode=prompt  craft prompt    (reconstruct the source desk's moves)
 *
 * Writes:
 *   cumulative_course_model.json
 *   courses/<slug>/index.md
 *   courses/<slug>/run-NNN.md
 *   courses/<slug>/_prompt.md          hidden from Astro glob ([^_]*.md)
 *   courses/<slug>/prompt.md           only with --publish-prompt
 *
 * Usage:
 *   bun course_builder3.js --url="https://..." --title="Demagoguery 101"
 *   bun course_builder3.js --url="https://futurism.com/..." --title="Snark 101" --mode=prompt
 *   bun course_builder3.js --url="https://..." --title="Demagoguery 101" --publish-prompt
 *
 * Astro-facing rules (no site code changes):
 *   - never write slug / course / id
 *   - only schema keys: title author date pubDate description tags source type
 *   - tags: Course + series-slug (+ Prompt on published prompt files)
 *   - author: Grok
 *   - index/prompt dates stay frozen at series.createdAt so rewrites do not jump the root feed
 *   - source omitted on index; modules use the article URL
 */

import fs from 'fs/promises';
import path from 'path';
import ogs from 'open-graph-scraper';

const MODEL_PATH = 'cumulative_course_model.json';
const COURSES_DIR = 'courses';
const THREAD_MODEL_PATH = 'cumulative_thread_model.json';
const DEFAULT_MODEL = process.env.XAI_MODEL || 'grok-4.6';
const SOURCE_CHAR_CAP = 12000;
const SPINE_CHAR_CAP = 1800;
const PROMPT_LINE_CAP = 40;
const PROMPT_CHAR_CAP = 2400;

const args = process.argv.slice(2);
const urlArg = args.find((a) => a.startsWith('--url='))?.slice(6);
const titleArg =
  args.find((a) => a.startsWith('--title='))?.slice(8) ||
  args.find((a) => a.startsWith('--course='))?.slice(9);
const forceLevel = args.find((a) => a.startsWith('--level='))?.slice(8);
const modeArg = (args.find((a) => a.startsWith('--mode='))?.slice(7) || 'course').toLowerCase();
const learnFromThreads = args.includes('--learn-from-threads');
const resetCourse = args.includes('--reset');
const dryRun = args.includes('--dry-run');
const publishPrompt = args.includes('--publish-prompt');

const MODES = {
  course: {
    temperature: 0.5,
    promptKind: 'analyst',
    system:
      'You are a precise course architect and prompt compressor. You write one new instructional layer, then a short standalone ANALYST system prompt that a later model could use to diagnose the same pattern in a fresh source. You do not write theatrical verse. You do not repeat prior modules. You treat earlier concepts as already taught. You never dump the full ledger into the new lesson or the prompt.',
  },
  prompt: {
    temperature: 0.65,
    promptKind: 'craft',
    system:
      'You are a prompt builder studying hostile tech-culture journalism. Extract reusable TECHNIQUES actually present on the page. Write a short teaching module about what is new in this article, then a compressed CRAFT system prompt a later model could follow. Do not invent quotes. Do not repeat techniques already in the ledger. The craft prompt must stay under forty short lines and must merge duplicates instead of appending.',
  },
};

function slugify(t) {
  return (t || '')
    .toString()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled-series';
}

function yamlString(value) {
  return JSON.stringify(value == null ? '' : String(value));
}

function normKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function similar(a, b) {
  const x = new Set(normKey(a).split(' ').filter((w) => w.length > 3));
  const y = new Set(normKey(b).split(' ').filter((w) => w.length > 3));
  if (!x.size || !y.size) return normKey(a) === normKey(b);
  let hit = 0;
  for (const w of x) if (y.has(w)) hit += 1;
  return hit / Math.min(x.size, y.size) >= 0.72;
}

function mergeUnique(oldList, incoming, max = 24) {
  const out = [...(oldList || [])];
  for (const item of incoming || []) {
    if (!item || item.length < 8) continue;
    if (out.some((prev) => similar(prev, item))) continue;
    out.push(item);
  }
  return out.slice(-max);
}

function splitList(text) {
  return (text || '')
    .split('\n')
    .map((l) => l.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '').trim())
    .filter((l) => l.length > 8)
    .slice(0, 8);
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
        headers: { 'User-Agent': 'Mozilla/5.0 Sourceverse-course-builder' },
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

async function loadCourseModel() {
  try {
    const raw = JSON.parse(await fs.readFile(MODEL_PATH, 'utf8'));
    if (!raw.series) raw.series = raw.courses || {};
    return raw;
  } catch {
    return { version: 3, series: {} };
  }
}

async function saveCourseModel(model) {
  model.version = 3;
  await fs.writeFile(MODEL_PATH, JSON.stringify(model, null, 2) + '\n', 'utf8');
}

function emptySeries(title, slug) {
  const now = new Date().toISOString();
  return {
    title,
    slug,
    createdAt: now,
    updatedAt: now,
    runCount: 0,
    currentLevel: 0,
    sophistication: 1.0,
    coreUrls: [],
    modulesCompleted: [],
    keyConcepts: [],
    structuralTensions: [],
    techniques: [],
    openQuestions: [],
    narrativeSpine: '',
    craftPrompt: '',
    analystPrompt: '',
    priorOutputs: [],
  };
}

async function optionalThreadPeek() {
  if (!learnFromThreads) return '';
  try {
    const raw = JSON.parse(await fs.readFile(THREAD_MODEL_PATH, 'utf8'));
    const arcs = raw.narrativeArcs || {};
    const hist = (raw.predictionHistory || []).slice(-6);
    const arcSnips = Object.entries(arcs)
      .slice(0, 4)
      .map(([dom, arc]) => {
        const text = (arc?.currentArc || '').slice(-360);
        return text ? `[${dom}] ${text}` : null;
      })
      .filter(Boolean);
    const hyps = hist
      .map((h) => (h.hypothesis || '').trim())
      .filter((h) => h.length > 40)
      .slice(-4);
    if (!arcSnips.length && !hyps.length) return '';
    return [
      'OPTIONAL READ-ONLY THREAD PEEK (use only if it sharpens this layer):',
      arcSnips.join('\n'),
      hyps.length ? `Hypotheses:\n- ${hyps.join('\n- ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  } catch {
    console.warn(`  --learn-from-threads set, but ${THREAD_MODEL_PATH} was not readable.`);
    return '';
  }
}

function nextLevelLabel(mode, level) {
  if (mode === 'prompt') {
    const labels = [
      'Inventory — name devices actually on the page',
      'Mechanics — framing, epithets, stacked morals',
      'Selection — what is amplified or treated as self-evident',
      'Voice kit — reusable cadences; compress the prompt',
      'Prompt compression — fold the ledger; delete duplicates',
    ];
    return labels[level - 1] || `Craft layer ${level} — only new moves; compress the prompt`;
  }
  const labels = [
    'Foundations — definitions and why the pattern matters',
    'Mechanisms — incentives and how the pattern reproduces',
    'Cases — concrete instances, compared',
    'System ecology — institutions and selection pressures',
    'Counter-dynamics — failure modes and open problems',
  ];
  return labels[level - 1] || `Advanced layer ${level} — new framework only; do not recap`;
}

function parseOutput(raw) {
  const sections = {
    module_title: '',
    level_intent: '',
    lesson: '',
    key_concepts: '',
    tensions: '',
    techniques: '',
    open_questions: '',
    spine_update: '',
    reusable_prompt: '',
    next_suggested: '',
  };
  let current = 'lesson';
  const text = String(raw || '').replace(/```/g, '');
  for (const line of text.split('\n')) {
    const l = line.trim().toLowerCase();
    if (/^(#+|\*\*)?\s*module title/.test(l)) current = 'module_title';
    else if (/^(#+|\*\*)?\s*level intent/.test(l)) current = 'level_intent';
    else if (/^(#+|\*\*)?\s*(lesson|module body|teaching text)/.test(l)) current = 'lesson';
    else if (/^(#+|\*\*)?\s*key concepts/.test(l)) current = 'key_concepts';
    else if (/^(#+|\*\*)?\s*(structural tensions|tensions)/.test(l)) current = 'tensions';
    else if (/^(#+|\*\*)?\s*(techniques|craft techniques)/.test(l)) current = 'techniques';
    else if (/^(#+|\*\*)?\s*open questions/.test(l)) current = 'open_questions';
    else if (/^(#+|\*\*)?\s*(spine update|narrative spine)/.test(l)) current = 'spine_update';
    else if (/^(#+|\*\*)?\s*(reusable prompt|craft prompt|analyst prompt|writing prompt|system prompt)/.test(l)) {
      current = 'reusable_prompt';
    } else if (/^(#+|\*\*)?\s*next suggested/.test(l)) current = 'next_suggested';
    else sections[current] += (sections[current] ? '\n' : '') + line;
  }
  for (const k of Object.keys(sections)) sections[k] = sections[k].trim();
  return sections;
}

async function callGrok(system, user, temperature = 0.55) {
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
      temperature,
      max_tokens: 6144,
      reasoning_effort: 'low',
    }),
  });
  if (!response.ok) throw new Error(`xAI API ${response.status}: ${await response.text()}`);
  const data = await response.json();
  const msg = data.choices?.[0]?.message;
  return (msg?.content || msg?.reasoning_content || '').trim();
}

function astroFrontMatter({ title, description, type, tags, source, dateIso }) {
  const day = dateIso.split('T')[0];
  const tagLines = tags.map((t) => `  - ${yamlString(t)}`).join('\n');
  const sourceLine = source ? `\nsource: ${yamlString(source)}` : '';
  return `---
title: ${yamlString(title)}
author: "Grok"
date: "${dateIso}"
pubDate: "${day}"
description: ${yamlString(description)}
tags:
${tagLines}
type: ${yamlString(type)}${sourceLine}
---`;
}

function buildIndexMarkdown(series) {
  const conceptList = (series.keyConcepts || []).map((c) => `- ${c}`).join('\n') || '- _None yet._';
  const tensionList = (series.structuralTensions || []).map((c) => `- ${c}`).join('\n') || '- _None yet._';
  const techList = (series.techniques || []).map((c) => `- ${c}`).join('\n') || '- _None yet._';
  const qList = (series.openQuestions || []).map((c) => `- ${c}`).join('\n') || '- _None yet._';
  const moduleList = (series.priorOutputs || [])
    .map((p) => `- [Run ${String(p.run).padStart(3, '0')} — ${p.moduleTitle}](./${path.basename(p.file)})`)
    .join('\n') || '- _No modules yet._';
  const urlList = (series.coreUrls || []).map((u) => `- ${u}`).join('\n') || '- _None._';

  return `${astroFrontMatter({
    title: series.title,
    description: `Syllabus for ${series.title}`,
    type: 'course-index',
    tags: ['Course', series.slug],
    source: '',
    dateIso: series.createdAt,
  })}

# ${series.title}

Each run adds one layer. Earlier modules stay as written.

## Modules

${moduleList}

## Sources

${urlList}

## Spine

${series.narrativeSpine || '_No spine yet._'}

## Concepts

${conceptList}

## Tensions

${tensionList}

## Techniques

${techList}

## Open questions

${qList}
`;
}

function buildRunMarkdown({ series, run, level, levelIntent, source, parsed, mode }) {
  const now = new Date().toISOString();
  const title = parsed.module_title || `${series.title} — Layer ${level}`;
  const newConcepts = splitList(parsed.key_concepts);
  const newTensions = splitList(parsed.tensions);
  const newTechniques = splitList(parsed.techniques);
  const newQuestions = splitList(parsed.open_questions);

  const list = (items) => items.map((c) => `- ${c}`).join('\n') || '- _None new._';

  return `${astroFrontMatter({
    title,
    description: `${series.title} · layer ${level}`,
    type: 'course-module',
    tags: ['Course', series.slug],
    source: source.url,
    dateIso: now,
  })}

# ${title}

[${series.title}](./index.md) · layer ${level} · ${levelIntent}

Source: [${source.title}](${source.url})

${parsed.lesson || '_No lesson body generated._'}

## New in this layer

**Concepts**

${list(newConcepts)}

**Tensions**

${list(newTensions)}

${mode === 'prompt' || newTechniques.length ? `**Techniques**\n\n${list(newTechniques)}\n` : ''}**Questions**

${list(newQuestions)}
`;
}

function buildPromptMarkdown(series, kind) {
  const body = kind === 'craft' ? series.craftPrompt : series.analystPrompt;
  const techList = (series.techniques || []).slice(-12).map((c) => `- ${c}`).join('\n') || '- _None yet._';
  return `${astroFrontMatter({
    title: `${series.title} — ${kind} prompt`,
    description: `${kind} prompt grown from ${series.title}`,
    type: 'course-prompt',
    tags: ['Course', series.slug, 'Prompt'],
    source: '',
    dateIso: series.createdAt,
  })}

# ${kind[0].toUpperCase() + kind.slice(1)} prompt

Standalone system prompt for **${series.title}**. Rewritten each run; not a ledger dump.

## Prompt

${body || '_No prompt compiled yet._'}

## Recent techniques

${techList}
`;
}

function buildUserPrompt({ mode, title, nextLevel, levelIntent, nextRun, series, source, peek }) {
  const already = (series.modulesCompleted || []).join('; ') || '(none)';
  const concepts = (series.keyConcepts || []).slice(-8).join('\n- ') || '(none)';
  const tensions = (series.structuralTensions || []).slice(-6).join('\n- ') || '(none)';
  const techniques = (series.techniques || []).slice(-10).join('\n- ') || '(none)';
  const questions = (series.openQuestions || []).slice(-6).join('\n- ') || '(none)';
  const spine = series.narrativeSpine || '(empty)';
  const existingPrompt =
    mode === 'prompt'
      ? series.craftPrompt || '(none — write the first craft prompt)'
      : series.analystPrompt || '(none — write the first analyst prompt)';

  const promptRules =
    mode === 'prompt'
      ? `Write a CRAFT system prompt in the second person. It teaches a model to recognize and, if asked, reconstruct the desk's moves. Keep it ≤ ${PROMPT_LINE_CAP} short lines. Merge old + new techniques. Delete duplicates and examples that only fit one article.`
      : `Write an ANALYST system prompt in the second person. It teaches a model to diagnose this course's pattern in a fresh source (warrants, conversions, selection effects). It is not a prompt for producing demagoguery. Keep it ≤ ${PROMPT_LINE_CAP} short lines. Merge old + new. Delete article-specific names unless they name the mechanism.`;

  return `SERIES: ${title}
LAYER: ${nextLevel} (${levelIntent})
RUN: ${nextRun}

ALREADY TAUGHT: ${already}

ALREADY STORED CONCEPTS:
- ${concepts}

ALREADY STORED TENSIONS:
- ${tensions}

ALREADY STORED TECHNIQUES:
- ${techniques}

OPEN QUESTIONS:
- ${questions}

CURRENT SPINE (replace, do not append):
${spine}

EXISTING REUSABLE PROMPT (compress; do not append):
${existingPrompt}

NEW SOURCE
Title: ${source.title}
URL: ${source.url}

${source.text}

${peek}

OUTPUT RULES
- Use the headers below, in order, nothing outside them.
- LESSON: 5–8 short paragraphs. One bridging sentence may mention a prior engine. Do not recap prior layers.
- KEY CONCEPTS / TENSIONS / TECHNIQUES / OPEN QUESTIONS: only NEW items. 3–5 bullets each. No restating the stored lists.
- SPINE UPDATE: one paragraph that subsumes prior engines. Not a concatenation.
- REUSABLE PROMPT: ${promptRules}

## MODULE TITLE
## LEVEL INTENT
## LESSON
## KEY CONCEPTS
## STRUCTURAL TENSIONS
## TECHNIQUES
## OPEN QUESTIONS
## SPINE UPDATE
## REUSABLE PROMPT
## NEXT SUGGESTED
`;
}

async function main() {
  if (!urlArg) {
    console.error('Required: --url="https://..."');
    console.error('  bun course_builder3.js --url="https://..." --title="Demagoguery 101"');
    console.error('  bun course_builder3.js --url="https://futurism.com/..." --title="Snark 101" --mode=prompt');
    process.exit(1);
  }

  const seriesTitle = (titleArg || 'Untitled Series').trim();
  const slug = slugify(seriesTitle);
  const seriesDir = path.join(COURSES_DIR, slug);
  const mode = MODES[modeArg] ? modeArg : 'course';
  if (!MODES[modeArg]) console.warn(`   Unknown --mode=${modeArg}; falling back to course`);
  const spec = MODES[mode];

  console.log(`\n📘 Course builder 3`);
  console.log(`   Title  : ${seriesTitle}`);
  console.log(`   Folder : ${seriesDir}`);
  console.log(`   Mode   : ${mode} (${spec.promptKind} prompt)`);
  console.log(`   Prompt : ${publishPrompt ? 'prompt.md (public)' : '_prompt.md (hidden from Astro glob)'}`);

  const model = await loadCourseModel();
  if (resetCourse || !model.series[slug]) {
    model.series[slug] = emptySeries(seriesTitle, slug);
    if (resetCourse) console.log('   Reset  : series state cleared');
  }
  const series = model.series[slug];
  series.title = seriesTitle;
  series.slug = slug;
  if (!series.createdAt) series.createdAt = new Date().toISOString();

  const nextRun = series.runCount + 1;
  const nextLevel = forceLevel ? parseInt(forceLevel, 10) || nextRun : nextRun;
  const levelIntent = nextLevelLabel(mode, nextLevel);

  console.log(`\n🔎 Enriching source...`);
  const source = await enrichUrl(urlArg);
  console.log(`   Title  : ${source.title}`);
  console.log(`   Chars  : ${source.text.length}`);

  const peek = await optionalThreadPeek();
  const user = buildUserPrompt({
    mode,
    title: seriesTitle,
    nextLevel,
    levelIntent,
    nextRun,
    series,
    source,
    peek,
  });

  if (dryRun) {
    console.log('\n🧪 --dry-run: prompt assembled, no API call, no writes.');
    return;
  }

  console.log(`\n🧠 Generating layer ${nextLevel} with ${DEFAULT_MODEL}...`);
  const raw = await callGrok(spec.system, user, spec.temperature);
  const parsed = parseOutput(raw);

  const runName = `run-${String(nextRun).padStart(3, '0')}.md`;
  const runPath = path.join(seriesDir, runName);
  await fs.mkdir(seriesDir, { recursive: true });
  await fs.writeFile(
    runPath,
    buildRunMarkdown({ series, run: nextRun, level: nextLevel, levelIntent, source, parsed, mode }),
    'utf8'
  );

  series.runCount = nextRun;
  series.currentLevel = nextLevel;
  series.sophistication = Number((1 + nextLevel * 0.35).toFixed(2));
  if (!series.coreUrls.includes(source.url)) series.coreUrls.push(source.url);
  const moduleTitle = parsed.module_title || `Layer ${nextLevel}`;
  series.modulesCompleted = mergeUnique(series.modulesCompleted, [moduleTitle], 40);
  series.keyConcepts = mergeUnique(series.keyConcepts, splitList(parsed.key_concepts), 30);
  series.structuralTensions = mergeUnique(series.structuralTensions, splitList(parsed.tensions), 20);
  series.techniques = mergeUnique(series.techniques, splitList(parsed.techniques), 30);
  series.openQuestions = mergeUnique(series.openQuestions, splitList(parsed.open_questions), 16);
  if (parsed.spine_update && parsed.spine_update.length > 40) {
    series.narrativeSpine = parsed.spine_update.slice(0, SPINE_CHAR_CAP);
  }
  if (parsed.reusable_prompt && parsed.reusable_prompt.length > 60) {
    const clipped = parsed.reusable_prompt.slice(0, PROMPT_CHAR_CAP);
    if (spec.promptKind === 'craft') series.craftPrompt = clipped;
    else series.analystPrompt = clipped;
  }
  series.priorOutputs = series.priorOutputs || [];
  series.priorOutputs.push({
    run: nextRun,
    level: nextLevel,
    mode,
    moduleTitle,
    file: runPath,
    source: source.url,
    at: new Date().toISOString(),
  });
  series.updatedAt = new Date().toISOString();

  await fs.writeFile(path.join(seriesDir, 'index.md'), buildIndexMarkdown(series), 'utf8');
  const promptKind = spec.promptKind;
  const promptBody = buildPromptMarkdown(series, promptKind);
  await fs.writeFile(path.join(seriesDir, '_prompt.md'), promptBody, 'utf8');
  if (publishPrompt) {
    await fs.writeFile(path.join(seriesDir, 'prompt.md'), promptBody, 'utf8');
  }

  await saveCourseModel(model);

  console.log(`\n✅ ${runPath}`);
  console.log(`✅ ${path.join(seriesDir, 'index.md')} (date frozen at ${series.createdAt})`);
  console.log(`✅ ${path.join(seriesDir, '_prompt.md')} (${promptKind})`);
  if (publishPrompt) console.log(`✅ ${path.join(seriesDir, 'prompt.md')} public`);
  console.log(`✅ ${MODEL_PATH}`);
  console.log(`   run ${nextRun} · concepts ${series.keyConcepts.length} · techniques ${series.techniques.length}`);
}

main().catch((err) => {
  console.error('Fatal course_builder3 error:', err);
  process.exit(1);
});

#!/usr/bin/env bun
/**
 * course_builder2.js
 *
 * Isolated from vertical_thread / cumulative_thread_model.json.
 * Writes only:
 *   cumulative_course_model.json
 *   courses/<slug>/index.md
 *   courses/<slug>/run-NNN.md
 *   courses/<slug>/prompt.md          (prompt-builder mode only)
 *
 * Modes:
 *   --mode=course   pedagogical course architect (default)
 *   --mode=prompt   snark prompt-builder: extract techniques from hostile
 *                   tech-culture copy (Futurism-style AI/Musk demagoguery)
 *                   and grow a reusable writing prompt
 *
 * Usage:
 *   bun course_builder2.js --url="https://..." --title="Demagoguery 101"
 *   bun course_builder2.js --url="https://futurism.com/..." --title="Snark 101" --mode=prompt
 *   bun course_builder2.js --url="https://..." --title="Snark 101" --mode=prompt --learn-from-threads
 *   bun course_builder2.js --url="https://..." --title="Snark 101" --reset
 *
 * Front matter is Astro-safe: no slug, no course, no id.
 * Collection id comes from the file path only.
 */

import fs from 'fs/promises';
import path from 'path';
import ogs from 'open-graph-scraper';

const MODEL_PATH = 'cumulative_course_model.json';
const COURSES_DIR = 'courses';
const THREAD_MODEL_PATH = 'cumulative_thread_model.json';
const DEFAULT_MODEL = process.env.XAI_MODEL || 'grok-4.6';
const SOURCE_CHAR_CAP = 14000;
const SPINE_CHAR_CAP = 6000;
const PROMPT_CHAR_CAP = 8000;

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

const MODES = {
  course: {
    temperature: 0.55,
    system:
      'You are a precise course architect. You write progressive instructional modules that become more sophisticated on each run. You do not write theatrical verse, stage directions, or media prompts. You write clean teaching prose: definitions, mechanisms, cases, and structural analysis. You never repeat a prior module. You treat earlier concepts as already taught.',
  },
  prompt: {
    temperature: 0.7,
    system:
      'You are a prompt builder studying hostile tech-culture journalism — Futurism and similar desks covering AI, Musk, labs, and founders. Your job is to reverse-engineer the snark: diction, framing, moral stacking, selective metric use, nickname-and-epithet economy, mock-innocent questions, and the move that treats a business or research failure as proof of a cosmic character flaw. Extract reusable TECHNIQUES, not a fan essay and not a denunciation of the targets. Do not invent quotes. Do not write theatrical verse. Each run must add techniques that were not already in the ledger.',
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
    return JSON.parse(await fs.readFile(MODEL_PATH, 'utf8'));
  } catch {
    return { version: 2, series: {} };
  }
}

async function saveCourseModel(model) {
  await fs.writeFile(MODEL_PATH, JSON.stringify(model, null, 2) + '\n', 'utf8');
}

function emptySeries(title, slug) {
  return {
    title,
    slug,
    createdAt: new Date().toISOString(),
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
    priorOutputs: [],
  };
}

async function optionalThreadPeek() {
  if (!learnFromThreads) return '';
  try {
    const raw = JSON.parse(await fs.readFile(THREAD_MODEL_PATH, 'utf8'));
    const arcs = raw.narrativeArcs || {};
    const hist = (raw.predictionHistory || []).slice(-8);
    const arcSnips = Object.entries(arcs)
      .slice(0, 6)
      .map(([dom, arc]) => {
        const text = (arc?.currentArc || '').slice(-500);
        return text ? `Domain [${dom}]: ${text}` : null;
      })
      .filter(Boolean);
    const hyps = hist
      .map((h) => (h.hypothesis || '').trim())
      .filter((h) => h.length > 40)
      .slice(-6);
    if (!arcSnips.length && !hyps.length) return '';
    return [
      '## OPTIONAL READ-ONLY PEEK AT EXISTING THREAD MEMORY',
      '(Do not treat this as canon. Use only if it sharpens the present module.)',
      arcSnips.length ? `Narrative fragments:\n${arcSnips.join('\n\n')}` : '',
      hyps.length ? `Recent hypotheses:\n- ${hyps.join('\n- ')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  } catch {
    console.warn(`  --learn-from-threads set, but ${THREAD_MODEL_PATH} was not readable.`);
    return '';
  }
}

function nextLevelLabel(mode, level) {
  if (mode === 'prompt') {
    const labels = [
      'Inventory — name the snark devices actually present in this article',
      'Mechanics — how framing, epithets, and stacked morals do the work',
      'Selection — what is amplified, omitted, or treated as self-evident',
      'Voice kit — reusable sentence moves, cadences, and mock-innocent questions',
      'Prompt compression — fold the ledger into a tighter writing prompt',
    ];
    return labels[level - 1] || `Advanced craft layer ${level} — add techniques not already stored; tighten the prompt`;
  }
  const labels = [
    'Foundations — definitions, surface examples, why the topic matters',
    'Mechanisms — incentives, feedback loops, how the pattern reproduces itself',
    'Cases — concrete contemporary and historical instances, compared carefully',
    'System ecology — institutions, information environments, selection pressures',
    'Counter-dynamics — failure modes of the pattern, exit conditions, open problems',
  ];
  return labels[level - 1] || `Advanced layer ${level} — raise density, introduce a new framework, do not recap`;
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
    craft_prompt: '',
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
    else if (/^(#+|\*\*)?\s*(techniques|craft techniques|snark techniques)/.test(l)) current = 'techniques';
    else if (/^(#+|\*\*)?\s*open questions/.test(l)) current = 'open_questions';
    else if (/^(#+|\*\*)?\s*(spine update|narrative spine)/.test(l)) current = 'spine_update';
    else if (/^(#+|\*\*)?\s*(craft prompt|writing prompt|system prompt)/.test(l)) current = 'craft_prompt';
    else if (/^(#+|\*\*)?\s*next suggested/.test(l)) current = 'next_suggested';
    else sections[current] += (sections[current] ? '\n' : '') + line;
  }
  for (const k of Object.keys(sections)) sections[k] = sections[k].trim();
  return sections;
}

function splitList(text) {
  return (text || '')
    .split('\n')
    .map((l) => l.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '').trim())
    .filter((l) => l.length > 8)
    .slice(0, 10);
}

function mergeUnique(oldList, incoming, max = 24) {
  const seen = new Set((oldList || []).map((s) => s.toLowerCase()));
  const out = [...(oldList || [])];
  for (const item of incoming || []) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.slice(-max);
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
      max_tokens: 8192,
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
  return `---
title: ${yamlString(title)}
author: "Grok"
date: "${dateIso}"
pubDate: "${day}"
description: ${yamlString(description)}
tags:
${tagLines}
type: ${yamlString(type)}
source: ${yamlString(source)}
---`;
}

function buildIndexMarkdown(series, mode) {
  const now = new Date().toISOString();
  const conceptList = (series.keyConcepts || []).map((c) => `- ${c}`).join('\n') || '- _None yet._';
  const tensionList = (series.structuralTensions || []).map((c) => `- ${c}`).join('\n') || '- _None yet._';
  const techList = (series.techniques || []).map((c) => `- ${c}`).join('\n') || '- _None yet._';
  const qList = (series.openQuestions || []).map((c) => `- ${c}`).join('\n') || '- _None yet._';
  const moduleList = (series.priorOutputs || [])
    .map((p) => `- [Run ${String(p.run).padStart(3, '0')} — ${p.moduleTitle}](./${path.basename(p.file)})`)
    .join('\n') || '- _No modules yet._';
  const urlList = (series.coreUrls || []).map((u) => `- ${u}`).join('\n') || '- _None._';
  const promptLink = mode === 'prompt' || series.craftPrompt
    ? '- [Evolving snark prompt](./prompt.md)'
    : '';

  return `${astroFrontMatter({
    title: series.title,
    description: `Syllabus for ${series.title}`,
    type: 'course-index',
    tags: ['Course', series.slug],
    source: 'index',
    dateIso: now,
  })}

# ${series.title}

Progressive series. Each run adds one layer. Earlier modules are not rewritten.

## Navigation

${promptLink}
${moduleList}

## Sources used

${urlList}

## Narrative spine

${series.narrativeSpine || '_No spine yet._'}

## Key concepts accumulated

${conceptList}

## Structural tensions

${tensionList}

## Craft techniques

${techList}

## Open questions

${qList}
`;
}

function buildRunMarkdown({ series, run, level, levelIntent, source, parsed, mode }) {
  const now = new Date().toISOString();
  const title = parsed.module_title || `${series.title} — Layer ${level}`;
  const techniqueBlock =
    mode === 'prompt' || parsed.techniques
      ? `## Craft techniques\n\n${parsed.techniques || '_None listed._'}\n`
      : '';

  return `${astroFrontMatter({
    title,
    description: `${series.title} · layer ${level}`,
    type: 'course-module',
    tags: ['Course', series.slug],
    source: source.url,
    dateIso: now,
  })}

# ${title}

- Series: [${series.title}](./index.md)
- Layer: ${level} / run ${String(run).padStart(3, '0')}
- Intent: ${levelIntent}

## Source

[${source.title}](${source.url})

## Lesson

${parsed.lesson || '_No lesson body generated._'}

## Key concepts in this module

${parsed.key_concepts || '_None listed._'}

## Structural tensions

${parsed.tensions || '_None listed._'}

${techniqueBlock}## Open questions

${parsed.open_questions || '_None listed._'}

## Spine update

${parsed.spine_update || '_None._'}

## Next suggested layer

${parsed.next_suggested || '_Continue with the next unused framework or a sharper case._'}
`;
}

function buildPromptMarkdown(series) {
  const now = new Date().toISOString();
  const techList = (series.techniques || []).map((c) => `- ${c}`).join('\n') || '- _None yet._';
  return `${astroFrontMatter({
    title: `${series.title} — evolving snark prompt`,
    description: `Reusable snark-writing prompt grown from ${series.title}`,
    type: 'course-prompt',
    tags: ['Course', series.slug, 'Prompt'],
    source: 'prompt',
    dateIso: now,
  })}

# Evolving snark prompt

Grown from hostile tech-culture articles ingested into **${series.title}**.
This file is overwritten each prompt-mode run as the ledger tightens.

## Current writing prompt

${series.craftPrompt || '_No prompt compiled yet._'}

## Technique ledger

${techList}
`;
}

function buildUserPrompt({ mode, title, nextLevel, levelIntent, nextRun, series, source, peek }) {
  const already = (series.modulesCompleted || []).join('; ') || '(none — first module)';
  const concepts = (series.keyConcepts || []).slice(-12).join('\n- ') || '(none yet)';
  const tensions = (series.structuralTensions || []).slice(-8).join('\n- ') || '(none yet)';
  const techniques = (series.techniques || []).slice(-16).join('\n- ') || '(none yet)';
  const questions = (series.openQuestions || []).slice(-8).join('\n- ') || '(none yet)';
  const spine = series.narrativeSpine || '(empty — invent the first spine from the source)';
  const existingPrompt = series.craftPrompt || '(none yet — write the first full prompt)';

  const sharedHead = `SERIES TITLE: ${title}
CURRENT LAYER: ${nextLevel}
LAYER INTENT: ${levelIntent}
THIS IS RUN ${nextRun}.

ALREADY COMPLETED MODULES:
${already}

KEY CONCEPTS ALREADY STORED:
- ${concepts}

STRUCTURAL TENSIONS ALREADY TRACKED:
- ${tensions}

OPEN QUESTIONS ALREADY ON THE TABLE:
- ${questions}

NARRATIVE SPINE SO FAR:
${spine.slice(-SPINE_CHAR_CAP)}

NEW SOURCE FOR THIS RUN
Title: ${source.title}
URL: ${source.url}

SOURCE TEXT:
${source.text}

${peek}`;

  if (mode === 'prompt') {
    return `${sharedHead}

TECHNIQUES ALREADY IN THE LEDGER (do not repeat):
- ${techniques}

EXISTING CRAFT PROMPT:
${existingPrompt.slice(-PROMPT_CHAR_CAP)}

TASK
Study the new source as hostile tech-culture copy. Extract snark techniques that are actually on the page: epithets, mock-innocent questions, moral stacking, metric cherry-picking, implied motives, cartoon villains, sanctimony-as-wit. Then write a short teaching module about those techniques AND a revised reusable writing prompt that a later model could follow.

OUTPUT RULES
- Output every header below, in this exact order, with no extra commentary outside them.
- Do not recap techniques already in the ledger.
- Do not invent quotations.
- The CRAFT PROMPT must be a standalone system prompt, written in the second person, usable without the rest of this file.

## MODULE TITLE
[Short title for this craft layer]

## LEVEL INTENT
[One sentence]

## LESSON
[How this article performs its hostility — devices, not a recap of the news]

## KEY CONCEPTS
[3–7 bullets]

## STRUCTURAL TENSIONS
[2–5 bullets: what the snark conceals or depends on]

## TECHNIQUES
[3–8 new reusable techniques, one bullet each, imperative form]

## OPEN QUESTIONS
[2–5]

## SPINE UPDATE
[One dense paragraph of what the series now knows about this house style]

## CRAFT PROMPT
[Full standalone system prompt incorporating old + new techniques]

## NEXT SUGGESTED
[What kind of hostile article would teach the next missing move]
`;
  }

  return `${sharedHead}

OUTPUT RULES
- Output every header below, in this exact order, with no extra commentary outside them.
- Do not recap introductory material if this is not layer 1.
- Ground claims in the new source. Name concrete actors, metrics, and mechanisms when the source provides them.
- Keep the lesson compact but dense: roughly 6–12 short paragraphs plus a few lists if needed.

## MODULE TITLE
[Short specific title for this layer only]

## LEVEL INTENT
[One sentence restating what this layer adds]

## LESSON
[The teaching text]

## KEY CONCEPTS
[3–7 bullet concepts introduced or sharpened in this layer]

## STRUCTURAL TENSIONS
[2–5 bullets: self-reinforcing loops, contradictions, selection effects]

## OPEN QUESTIONS
[2–5 questions this layer cannot yet answer]

## SPINE UPDATE
[One dense paragraph that can replace/extend the series spine]

## NEXT SUGGESTED
[One sentence: the most useful next layer if another URL is supplied later]
`;
}

async function main() {
  if (!urlArg) {
    console.error('Required: --url="https://..."');
    console.error('Example: bun course_builder2.js --url="https://thehill.com/..." --title="Demagoguery 101"');
    console.error('         bun course_builder2.js --url="https://futurism.com/..." --title="Snark 101" --mode=prompt');
    process.exit(1);
  }

  const seriesTitle = (titleArg || 'Untitled Series').trim();
  const slug = slugify(seriesTitle);
  const seriesDir = path.join(COURSES_DIR, slug);
  const mode = MODES[modeArg] ? modeArg : 'course';
  if (!MODES[modeArg]) console.warn(`   Unknown --mode=${modeArg}; falling back to course`);
  const spec = MODES[mode];

  console.log(`\n📘 Course builder 2`);
  console.log(`   Title  : ${seriesTitle}`);
  console.log(`   Folder : ${seriesDir}`);
  console.log(`   Mode   : ${mode}`);
  console.log(`   URL    : ${urlArg}`);
  console.log(`   Memory : ${MODEL_PATH} (thread model untouched)`);

  const model = await loadCourseModel();
  if (!model.series) model.series = model.courses || {};
  if (resetCourse || !model.series[slug]) {
    model.series[slug] = emptySeries(seriesTitle, slug);
    if (resetCourse) console.log('   Reset  : series state cleared');
  }
  const series = model.series[slug];
  series.title = seriesTitle;
  series.slug = slug;

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
    console.log(`   Would write ${path.join(seriesDir, `run-${String(nextRun).padStart(3, '0')}.md`)}`);
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
  series.keyConcepts = mergeUnique(series.keyConcepts, splitList(parsed.key_concepts), 40);
  series.structuralTensions = mergeUnique(series.structuralTensions, splitList(parsed.tensions), 24);
  series.techniques = mergeUnique(series.techniques, splitList(parsed.techniques), 40);
  series.openQuestions = mergeUnique(series.openQuestions, splitList(parsed.open_questions), 24);
  if (parsed.spine_update && parsed.spine_update.length > 40) {
    const combined = (series.narrativeSpine + '\n\n' + parsed.spine_update).trim();
    series.narrativeSpine = combined.length > SPINE_CHAR_CAP ? combined.slice(-SPINE_CHAR_CAP) : combined;
  }
  if (parsed.craft_prompt && parsed.craft_prompt.length > 80) {
    series.craftPrompt = parsed.craft_prompt.slice(0, PROMPT_CHAR_CAP);
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

  await fs.writeFile(path.join(seriesDir, 'index.md'), buildIndexMarkdown(series, mode), 'utf8');
  if (mode === 'prompt' || series.craftPrompt) {
    await fs.writeFile(path.join(seriesDir, 'prompt.md'), buildPromptMarkdown(series), 'utf8');
  }
  await saveCourseModel(model);

  console.log(`\n✅ Wrote ${runPath}`);
  console.log(`✅ Updated ${path.join(seriesDir, 'index.md')}`);
  if (mode === 'prompt' || series.craftPrompt) {
    console.log(`✅ Updated ${path.join(seriesDir, 'prompt.md')}`);
  }
  console.log(`✅ Saved ${MODEL_PATH} (thread model untouched)`);
  console.log(`   Run ${nextRun} | level ${nextLevel} | techniques ${series.techniques.length}`);
}

main().catch((err) => {
  console.error('Fatal course_builder2 error:', err);
  process.exit(1);
});

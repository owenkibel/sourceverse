#!/usr/bin/env bun
/**
 * course_builder.js — thin progressive-course runner
 *
 * Isolated from vertical_thread / cumulative_thread_model.json.
 * Writes only:
 *   - cumulative_course_model.json
 *   - courses/<slug>/index.md
 *   - courses/<slug>/run-NNN.md
 *
 * Usage:
 *   bun course_builder.js --url="https://..." --course="Demagoguery 101"
 *   bun course_builder.js --url="https://..." --course="Demagoguery 101" --learn-from-threads
 *   bun course_builder.js --url="https://..." --course="Demagoguery 101" --reset
 *   bun course_builder.js --url="https://..." --course="Demagoguery 101" --dry-run
 */

import fs from 'fs/promises';
import path from 'path';
import ogs from 'open-graph-scraper';

const MODEL_PATH = 'cumulative_course_model.json';
const COURSES_DIR = 'courses';
const THREAD_MODEL_PATH = 'cumulative_thread_model.json'; // read-only, never written
const DEFAULT_MODEL = process.env.XAI_MODEL || 'grok-4.6';
const SOURCE_CHAR_CAP = 14000;
const SPINE_CHAR_CAP = 6000;

const args = process.argv.slice(2);
const urlArg = args.find((a) => a.startsWith('--url='))?.slice(6);
const courseArg = args.find((a) => a.startsWith('--course='))?.slice(9);
const forceLevel = args.find((a) => a.startsWith('--level='))?.slice(8);
const learnFromThreads = args.includes('--learn-from-threads');
const resetCourse = args.includes('--reset');
const dryRun = args.includes('--dry-run');

function slugify(t) {
  return (t || '')
    .toString()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled-course';
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
    return { version: 1, courses: {} };
  }
}

async function saveCourseModel(model) {
  await fs.writeFile(MODEL_PATH, JSON.stringify(model, null, 2) + '\n', 'utf8');
}

function emptyCourse(title, slug) {
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
    openQuestions: [],
    narrativeSpine: '',
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
      '(Do not treat this as course canon. Use only if it sharpens the present module.)',
      arcSnips.length ? `Narrative fragments:\n${arcSnips.join('\n\n')}` : '',
      hyps.length ? `Recent hypotheses:\n- ${hyps.join('\n- ')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  } catch {
    console.warn('  --learn-from-threads set, but cumulative_thread_model.json was not readable.');
    return '';
  }
}

function nextLevelLabel(level) {
  const labels = [
    'Foundations — definitions, surface examples, why the topic matters',
    'Mechanisms — incentives, feedback loops, how the pattern reproduces itself',
    'Cases — concrete contemporary and historical instances, compared carefully',
    'System ecology — institutions, information environments, selection pressures',
    'Counter-dynamics — failure modes of the pattern, exit conditions, open problems',
  ];
  if (level <= labels.length) return labels[level - 1];
  return `Advanced layer ${level} — raise density, introduce a new framework, do not recap earlier modules`;
}

function parseCourseOutput(raw) {
  const sections = {
    module_title: '',
    level_intent: '',
    lesson: '',
    key_concepts: '',
    tensions: '',
    open_questions: '',
    spine_update: '',
    next_suggested: '',
  };
  let current = 'lesson';
  const lines = String(raw || '').replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, '')).split('\n');
  for (const line of lines) {
    const l = line.trim().toLowerCase();
    if (/^(#+|\*\*)?\s*module title/.test(l)) current = 'module_title';
    else if (/^(#+|\*\*)?\s*level intent/.test(l)) current = 'level_intent';
    else if (/^(#+|\*\*)?\s*(lesson|module body|teaching text)/.test(l)) current = 'lesson';
    else if (/^(#+|\*\*)?\s*key concepts/.test(l)) current = 'key_concepts';
    else if (/^(#+|\*\*)?\s*(structural tensions|tensions)/.test(l)) current = 'tensions';
    else if (/^(#+|\*\*)?\s*open questions/.test(l)) current = 'open_questions';
    else if (/^(#+|\*\*)?\s*(spine update|narrative spine)/.test(l)) current = 'spine_update';
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
    .slice(0, 8);
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

async function callGrok(system, user) {
  if (!process.env.XAI_API_KEY) {
    throw new Error('XAI_API_KEY is required');
  }
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
      temperature: 0.55,
      max_tokens: 8192,
      reasoning_effort: 'low',
    }),
  });
  if (!response.ok) {
    throw new Error(`xAI API ${response.status}: ${await response.text()}`);
  }
  const data = await response.json();
  const msg = data.choices?.[0]?.message;
  return (msg?.content || msg?.reasoning_content || '').trim();
}

function buildIndexMarkdown(course) {
  const conceptList = (course.keyConcepts || []).map((c) => `- ${c}`).join('\n') || '- _None yet._';
  const tensionList = (course.structuralTensions || []).map((c) => `- ${c}`).join('\n') || '- _None yet._';
  const qList = (course.openQuestions || []).map((c) => `- ${c}`).join('\n') || '- _None yet._';
  const moduleList = (course.priorOutputs || [])
    .map((p) => `- [Run ${String(p.run).padStart(3, '0')} — ${p.moduleTitle}](./${path.basename(p.file)})`)
    .join('\n') || '- _No modules yet._';
  const urlList = (course.coreUrls || []).map((u) => `- ${u}`).join('\n') || '- _None._';

  return `---
title: ${JSON.stringify(course.title)}
slug: ${course.slug}
updated: ${new Date().toISOString()}
runs: ${course.runCount}
level: ${course.currentLevel}
sophistication: ${course.sophistication}
---

# ${course.title}

Progressive course. Each run adds one layer. Earlier modules are not rewritten.

## Navigation

${moduleList}

## Sources used

${urlList}

## Narrative spine

${course.narrativeSpine || '_No spine yet._'}

## Key concepts accumulated

${conceptList}

## Structural tensions

${tensionList}

## Open questions

${qList}
`;
}

function buildRunMarkdown({ course, run, level, levelIntent, source, parsed }) {
  const title = parsed.module_title || `${course.title} — Layer ${level}`;
  return `---
title: ${JSON.stringify(title)}
course: ${JSON.stringify(course.title)}
slug: ${course.slug}
run: ${run}
level: ${level}
date: ${new Date().toISOString()}
source: ${JSON.stringify(source.url)}
---

# ${title}

- Course: [${course.title}](./index.md)
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

## Open questions

${parsed.open_questions || '_None listed._'}

## Spine update

${parsed.spine_update || '_None._'}

## Next suggested layer

${parsed.next_suggested || '_Continue with the next unused framework or a sharper case._'}
`;
}

async function main() {
  if (!urlArg) {
    console.error('Required: --url="https://..."');
    console.error('Example: bun course_builder.js --url="https://thehill.com/..." --course="Demagoguery 101"');
    process.exit(1);
  }

  const courseTitle = (courseArg || 'Untitled Course').trim();
  const slug = slugify(courseTitle);
  const courseDir = path.join(COURSES_DIR, slug);

  console.log(`\n📘 Course builder`);
  console.log(`   Course : ${courseTitle}`);
  console.log(`   Slug   : ${slug}`);
  console.log(`   URL    : ${urlArg}`);
  console.log(`   Memory : ${MODEL_PATH} (isolated from thread model)`);
  if (learnFromThreads) console.log(`   Peek   : read-only look at ${THREAD_MODEL_PATH}`);

  const model = await loadCourseModel();
  if (!model.courses) model.courses = {};
  if (resetCourse || !model.courses[slug]) {
    model.courses[slug] = emptyCourse(courseTitle, slug);
    if (resetCourse) console.log('   Reset  : course state cleared');
  }
  const course = model.courses[slug];
  course.title = courseTitle;
  course.slug = slug;

  const nextRun = course.runCount + 1;
  const nextLevel = forceLevel ? parseInt(forceLevel, 10) || nextRun : nextRun;
  const levelIntent = nextLevelLabel(nextLevel);

  console.log(`\n🔎 Enriching source...`);
  const source = await enrichUrl(urlArg);
  console.log(`   Title  : ${source.title}`);
  console.log(`   Chars  : ${source.text.length}`);

  const peek = await optionalThreadPeek();
  const already = (course.modulesCompleted || []).join('; ') || '(none — this is the first module)';
  const concepts = (course.keyConcepts || []).slice(-12).join('\n- ') || '(none yet)';
  const tensions = (course.structuralTensions || []).slice(-8).join('\n- ') || '(none yet)';
  const questions = (course.openQuestions || []).slice(-8).join('\n- ') || '(none yet)';
  const spine = course.narrativeSpine || '(empty — invent the first spine from the source)';

  const system = `You are a precise course architect. You write progressive instructional modules that become more sophisticated on each run. You do not write theatrical verse, stage directions, or media prompts. You write clean teaching prose: definitions, mechanisms, cases, and structural analysis. You never repeat a prior module. You treat earlier concepts as already taught.`;

  const user = `Build the next module for the course "${courseTitle}".

CURRENT LAYER: ${nextLevel}
LAYER INTENT: ${levelIntent}
THIS IS RUN ${nextRun}.

ALREADY TAUGHT MODULES:
${already}

KEY CONCEPTS ALREADY IN THE COURSE:
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

${peek}

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
[One dense paragraph that can replace/extend the course spine. Include what is now known.]

## NEXT SUGGESTED
[One sentence: the most useful next layer if another URL is supplied later]
`;

  if (dryRun) {
    console.log('\n🧪 --dry-run: prompt assembled, no API call, no writes.');
    console.log(`   Would write ${path.join(courseDir, `run-${String(nextRun).padStart(3, '0')}.md`)}`);
    return;
  }

  console.log(`\n🧠 Generating layer ${nextLevel} with ${DEFAULT_MODEL}...`);
  const raw = await callGrok(system, user);
  const parsed = parseCourseOutput(raw);

  const runName = `run-${String(nextRun).padStart(3, '0')}.md`;
  const runPath = path.join(courseDir, runName);
  await fs.mkdir(courseDir, { recursive: true });
  await fs.writeFile(
    runPath,
    buildRunMarkdown({ course, run: nextRun, level: nextLevel, levelIntent, source, parsed }),
    'utf8'
  );

  course.runCount = nextRun;
  course.currentLevel = nextLevel;
  course.sophistication = Number((1 + nextLevel * 0.35).toFixed(2));
  if (!course.coreUrls.includes(source.url)) course.coreUrls.push(source.url);
  const moduleTitle = parsed.module_title || `Layer ${nextLevel}`;
  course.modulesCompleted = mergeUnique(course.modulesCompleted, [moduleTitle], 40);
  course.keyConcepts = mergeUnique(course.keyConcepts, splitList(parsed.key_concepts), 40);
  course.structuralTensions = mergeUnique(course.structuralTensions, splitList(parsed.tensions), 24);
  course.openQuestions = mergeUnique(course.openQuestions, splitList(parsed.open_questions), 24);
  if (parsed.spine_update && parsed.spine_update.length > 40) {
    const combined = (course.narrativeSpine + '\n\n' + parsed.spine_update).trim();
    course.narrativeSpine = combined.length > SPINE_CHAR_CAP ? combined.slice(-SPINE_CHAR_CAP) : combined;
  }
  course.priorOutputs = course.priorOutputs || [];
  course.priorOutputs.push({
    run: nextRun,
    level: nextLevel,
    moduleTitle,
    file: runPath,
    source: source.url,
    at: new Date().toISOString(),
  });
  course.updatedAt = new Date().toISOString();

  await fs.writeFile(path.join(courseDir, 'index.md'), buildIndexMarkdown(course), 'utf8');
  await saveCourseModel(model);

  console.log(`\n✅ Wrote ${runPath}`);
  console.log(`✅ Updated ${path.join(courseDir, 'index.md')}`);
  console.log(`✅ Saved ${MODEL_PATH} (thread model untouched)`);
  console.log(`   Run ${nextRun} | level ${nextLevel} | concepts ${course.keyConcepts.length}`);
}

main().catch((err) => {
  console.error('Fatal course_builder error:', err);
  process.exit(1);
});

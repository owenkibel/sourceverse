#!/usr/bin/env bun
/**
 * course_builder5.js
 *
 * v4 plus Playwright enrichment for long X/Twitter posts and thin pages.
 * OGS still runs first. Playwright launches only for x.com / twitter.com
 * or when the extracted body is under 400 characters.
 *
 * Author-style series use --mode=prompt and a new title:
 *   bun course_builder5.js --url="https://x.com/ConradMBlack/status/..." --title="Black 101" --mode=prompt
 */

import fs from 'fs/promises';
import path from 'path';
import ogs from 'open-graph-scraper';
import { firefox } from 'playwright';

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
const rawMode = (args.find((a) => a.startsWith('--mode='))?.slice(7) || 'course').toLowerCase();
const learnFromThreads = args.includes('--learn-from-threads');
const resetCourse = args.includes('--reset');
const dryRun = args.includes('--dry-run');
const publishPrompt = args.includes('--publish-prompt');

const MODE_ALIASES = { snark: 'prompt', craft: 'prompt' };
const modeArg = MODE_ALIASES[rawMode] || rawMode;

const MODES = {
  course: {
    temperature: 0.5,
    promptKind: 'analyst',
    promptField: 'analystPrompt',
    system:
      'You are a precise course architect and prompt compressor. You write one new instructional layer, then a short standalone ANALYST system prompt that a later model could use to diagnose the same pattern in a fresh source. You do not write theatrical verse. You do not repeat prior modules. You treat earlier concepts as already taught. You never dump the full ledger into the new lesson or the prompt.',
  },
  prompt: {
    temperature: 0.65,
    promptKind: 'craft',
    promptField: 'craftPrompt',
    system:
      'You are a prompt builder studying a signed columnist or author desk. Extract reusable TECHNIQUES actually present on the page (cadence, selection, close). Write a short teaching module about what is new in this article, then a compressed CRAFT system prompt a later model could follow. Call it desk craft or column craft — never "hostile craft" and never assume the beat is tech-culture attack journalism. Do not invent quotes. Do not repeat techniques already in the ledger. The craft prompt must stay under forty short lines and must merge duplicates instead of appending. The reusable prompt is a style kit: it must tell a later model to omit devices the new page does not support rather than forge them.',
  },
  humor: {
    temperature: 0.7,
    promptKind: 'humor',
    promptField: 'humorPrompt',
    system:
      'You are a prompt builder studying comic prose: light essays, comic columns, observational standup-on-the-page, incongruity, understatement, and timing. Humor is not attack. Extract reusable TECHNIQUES actually present on the page (setup/payoff, misdirection, deadpan, list-as-joke, persona of the mild observer). Write a short teaching module about what is new, then a compressed HUMOR system prompt. Do not invent quotes. Do not turn the prompt into snark or satire. Keep the humor prompt under forty short lines and merge duplicates.',
  },
  satire: {
    temperature: 0.65,
    promptKind: 'satire',
    promptField: 'satirePrompt',
    system:
      'You are a prompt builder studying satire: irony, parody of official forms, exaggeration that has a target, persona, mock-proposal, and moral pressure applied through comedy. Satire is not mere jokiness and not mere snark. Extract reusable TECHNIQUES actually present on the page. Write a short teaching module about what is new, then a compressed SATIRE system prompt a later model could follow. Do not invent quotes. Do not write a how-to for harassment or violence. Keep the satire prompt under forty short lines and merge duplicates.',
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

function isXUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host === 'x.com' || host === 'twitter.com' || host === 'mobile.twitter.com';
  } catch {
    return /x\.com|twitter\.com/i.test(url);
  }
}

function xStatusId(url) {
  const m = String(url).match(/status\/(\d+)/);
  return m ? m[1] : null;
}

async function fetchXViaFx(url) {
  const id = xStatusId(url);
  if (!id) return null;
  const endpoints = [
    `https://api.fxtwitter.com/status/${id}`,
    `https://api.vxtwitter.com/Twitter/status/${id}`,
  ];
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep, {
        headers: { 'User-Agent': 'Mozilla/5.0 Sourceverse-course-builder' },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const tweet = data.tweet || data;
      const text = String(tweet.text || tweet.full_text || '').trim();
      if (!text) continue;
      const author = tweet.author?.name || tweet.user_name || tweet.authorName || '';
      const handle = tweet.author?.screen_name || tweet.user_screen_name || '';
      const quote = tweet.quote || tweet.quoted_tweet || tweet.quoted_status;
      const quoteText = quote
        ? `\n\nQuoted:\n${quote.author?.name || quote.user_name || ''} ${quote.text || quote.full_text || ''}`.trim()
        : '';
      return {
        ogTitle: [author, handle && `@${handle}`].filter(Boolean).join(' ') || 'X post',
        ogDescription: text + quoteText,
        kind: 'x-fx',
      };
    } catch (err) {
      console.warn(`  fx/vx Twitter ${ep} failed: ${err.message}`);
    }
  }
  return null;
}

async function fetchWithPlaywright(url) {
  const storage = process.env.PLAYWRIGHT_STORAGE || process.env.X_STORAGE_STATE;
  const browser = await firefox.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
    viewport: { width: 1280, height: 2200 },
    storageState: storage || undefined,
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    try {
      await page.waitForSelector(
        '[data-testid="tweetText"], [data-testid="tweet"], article[data-testid="tweet"], [data-testid="twitterArticleRichTextView"]',
        { timeout: 18000 }
      );
    } catch {
      console.warn('  Playwright: tweet node never appeared (login wall or blank shell).');
    }
    await page.waitForTimeout(1500);

    if (isXUrl(url)) {
      await page.evaluate(async () => {
        for (let i = 0; i < 8; i++) {
          window.scrollBy(0, 1400);
          await new Promise((r) => setTimeout(r, 450));
        }
        document.querySelectorAll('button, div[role="button"], span').forEach((btn) => {
          const t = (btn.innerText || '').toLowerCase();
          if (
            t.includes('show more') ||
            t.includes('show replies') ||
            t.includes('view more') ||
            t.includes('see more')
          ) {
            try {
              btn.click();
            } catch {}
          }
        });
      });
      await page.waitForTimeout(1200);
    }

    const data = await page.evaluate((targetUrl) => {
      const isX = /x\.com|twitter\.com/i.test(targetUrl);
      if (isX) {
        const articleTitleEl = document.querySelector('[data-testid="twitter-article-title"]');
        const articleBodyEl =
          document.querySelector('[data-testid="twitterArticleRichTextView"]') ||
          document.querySelector('[data-testid="twitterArticleReadView"]');
        if (articleBodyEl) {
          const title = (articleTitleEl?.innerText || document.title || '').trim();
          const paragraphs = Array.from(
            articleBodyEl.querySelectorAll(
              'p, [data-block="true"], .public-DraftStyleDefault-block, h1, h2, h3, li'
            )
          )
            .map((el) => el.innerText.trim())
            .filter((t) => t.length > 20);
          const fullText = paragraphs.length ? paragraphs.join('\n\n') : articleBodyEl.innerText.trim();
          return { ogTitle: title || 'X Article', paragraphs: [fullText], kind: 'x-article' };
        }

        const tweets = Array.from(
          document.querySelectorAll(
            '[data-testid="tweetText"], article[data-testid="tweet"] div[lang], article[data-testid="tweet"] [dir="auto"]'
          )
        )
          .map((el) => el.innerText.trim())
          .filter((t) => t.length > 12);

        const quoted = Array.from(document.querySelectorAll('[data-testid="tweet"]'))
          .slice(0, 4)
          .map((card) => {
            const name = card.querySelector('[data-testid="User-Name"]')?.innerText?.split('\n')[0] || '';
            const text = card.querySelector('[data-testid="tweetText"]')?.innerText?.trim() || '';
            return text ? `${name ? name + ': ' : ''}${text}` : '';
          })
          .filter(Boolean);

        const header =
          document.querySelector('[data-testid="User-Name"]')?.innerText?.split('\n')[0] ||
          document.querySelector('h1, h2')?.innerText ||
          document.title ||
          '';

        const primary = tweets[0] || '';
        const rest = tweets.slice(1, 10);
        const paragraphs = [];
        if (primary) paragraphs.push(primary);
        if (quoted.length > 1) paragraphs.push('Quoted / thread context:\n' + quoted.slice(1).join('\n\n'));
        if (rest.length) paragraphs.push(rest.join('\n\n'));

        return {
          ogTitle: (header || 'X post').trim(),
          paragraphs,
          kind: 'x-post',
        };
      }

      const article = document.querySelector('article') || document.querySelector('main') || document.body;
      const title =
        document.querySelector('h1')?.innerText?.trim() ||
        document.querySelector('meta[property="og:title"]')?.content ||
        document.title ||
        '';
      const paras = Array.from(article.querySelectorAll('p, h2, h3, li'))
        .map((el) => el.innerText.trim())
        .filter((t) => t.length > 40);
      return {
        ogTitle: title,
        paragraphs: paras.length ? [paras.join('\n\n')] : [article.innerText.trim()],
        kind: 'page',
      };
    }, url);

    return {
      ogTitle: data?.ogTitle || '',
      ogDescription: (data?.paragraphs || []).filter(Boolean).join('\n\n').trim(),
      kind: data?.kind || 'page',
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function enrichUrl(url) {
  let title = url;
  let description = '';
  let body = '';
  const xUrl = isXUrl(url);

  if (!xUrl) {
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
  }

  if (xUrl) {
    try {
      console.log('  fx/vx Twitter API extract...');
      const fx = await fetchXViaFx(url);
      if (fx?.ogDescription) {
        title = fx.ogTitle || title;
        body = fx.ogDescription;
        description = fx.ogDescription.slice(0, 280);
        console.log(`  fx/vx got ${body.length} chars (${fx.kind})`);
      }
    } catch (err) {
      console.warn(`  fx/vx failed: ${err.message}`);
    }
  }

  const thin = !body || body.length < 400;
  if (xUrl || thin) {
    if (body && body.length >= 400 && xUrl) {
      // already have a long fx extract
    } else {
      try {
        console.log(`  Playwright ${xUrl ? 'X' : 'thin-page'} extract...`);
        const pw = await fetchWithPlaywright(url);
        if (pw.ogTitle && (title === url || xUrl)) title = pw.ogTitle;
        if (pw.ogDescription && pw.ogDescription.length > (body || '').length) {
          body = pw.ogDescription;
          description = description || pw.ogDescription.slice(0, 280);
        }
        console.log(`  Playwright got ${(body || '').length} chars (${pw.kind || 'page'})`);
      } catch (err) {
        console.warn(`  Playwright failed: ${err.message}`);
      }
    }
  }

  let combined = [description, body].filter(Boolean).join('\n\n').trim();
  if (description && body && body.startsWith(description.slice(0, 80))) {
    combined = body;
  }
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
    return { version: 4, series: {} };
  }
}

async function saveCourseModel(model) {
  model.version = 4;
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
    humorPrompt: '',
    satirePrompt: '',
    lastPromptKind: '',
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
  const tables = {
    prompt: [
      'Inventory — name devices actually on the page',
      'Mechanics — framing, epithets, stacked morals',
      'Selection — what is amplified or treated as self-evident',
      'Voice kit — reusable cadences; compress the prompt',
      'Prompt compression — fold the ledger; delete duplicates',
    ],
    humor: [
      'Inventory — comic devices actually on the page',
      'Timing — setup, delay, payoff, understatement',
      'Persona — who is allowed to be the fool',
      'Voice kit — reusable cadences; compress the prompt',
      'Prompt compression — fold the ledger; delete duplicates',
    ],
    satire: [
      'Inventory — satirical devices actually on the page',
      'Target and vehicle — what is mocked, through what form',
      'Irony load — persona, parody, mock-proposal',
      'Voice kit — reusable cadences; compress the prompt',
      'Prompt compression — fold the ledger; delete duplicates',
    ],
    course: [
      'Foundations — definitions and why the pattern matters',
      'Mechanisms — incentives and how the pattern reproduces',
      'Cases — concrete instances, compared',
      'System ecology — institutions and selection pressures',
      'Counter-dynamics — failure modes and open problems',
    ],
  };
  const labels = tables[mode] || tables.course;
  return labels[level - 1] || `Layer ${level} — only new moves; compress the prompt`;
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
    else if (/^(#+|\*\*)?\s*(reusable prompt|craft prompt|analyst prompt|humor prompt|satire prompt|writing prompt|system prompt)/.test(l)) {
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
  const showTech = mode !== 'course' || newTechniques.length;

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

${showTech ? `**Techniques**\n\n${list(newTechniques)}\n` : ''}**Questions**

${list(newQuestions)}
`;
}

function buildPromptMarkdown(series, kind, field) {
  const body = series[field] || '';
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

function promptRulesFor(mode, spec) {
  const cap = `Keep it ≤ ${PROMPT_LINE_CAP} short lines. Merge old + new techniques. Delete duplicates and examples that only fit one article.`;
  if (mode === 'prompt') {
    return `Write a CRAFT system prompt in the second person. It is a style kit for this desk's cadence and selection, not an attack checklist. Teach a later model to use only moves present on a new page and to omit midterm clocks, named shaming, slogan flips, or other devices the page does not contain. Never use the phrase "hostile craft". ${cap}`;
  }
  if (mode === 'humor') {
    return `Write a HUMOR system prompt in the second person. It teaches a model to write comic observation, not attack and not satire. ${cap}`;
  }
  if (mode === 'satire') {
    return `Write a SATIRE system prompt in the second person. It teaches a model to aim irony at a target through form (parody, mock-proposal, persona). It is not a harassment script. ${cap}`;
  }
  return `Write an ANALYST system prompt in the second person. It teaches a model to diagnose this course's pattern in a fresh source (warrants, conversions, selection effects). It is not a prompt for producing demagoguery. ${cap}`;
}

function buildUserPrompt({ mode, spec, title, nextLevel, levelIntent, nextRun, series, source, peek }) {
  const already = (series.modulesCompleted || []).join('; ') || '(none)';
  const concepts = (series.keyConcepts || []).slice(-8).join('\n- ') || '(none)';
  const tensions = (series.structuralTensions || []).slice(-6).join('\n- ') || '(none)';
  const techniques = (series.techniques || []).slice(-10).join('\n- ') || '(none)';
  const questions = (series.openQuestions || []).slice(-6).join('\n- ') || '(none)';
  const spine = series.narrativeSpine || '(empty)';
  const existingPrompt = series[spec.promptField] || `(none — write the first ${spec.promptKind} prompt)`;

  return `SERIES: ${title}
LAYER: ${nextLevel} (${levelIntent})
RUN: ${nextRun}
PROMPT KIND: ${spec.promptKind}

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
- REUSABLE PROMPT: ${promptRulesFor(mode, spec)}

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
    console.error('  bun course_builder5.js --url="https://..." --title="Demagoguery 101"');
    console.error('  bun course_builder5.js --url="https://x.com/ConradMBlack/status/..." --title="Black 101" --mode=prompt');
    console.error('  bun course_builder5.js --url="https://..." --title="Humor 101" --mode=humor');
    console.error('  bun course_builder5.js --url="https://..." --title="Satire 101" --mode=satire');
    process.exit(1);
  }

  const seriesTitle = (titleArg || 'Untitled Series').trim();
  const slug = slugify(seriesTitle);
  const seriesDir = path.join(COURSES_DIR, slug);
  const mode = MODES[modeArg] ? modeArg : 'course';
  if (!MODES[modeArg]) console.warn(`   Unknown --mode=${rawMode}; falling back to course`);
  const spec = MODES[mode];

  console.log(`\n📘 Course builder 5`);
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
  if (series.humorPrompt == null) series.humorPrompt = '';
  if (series.satirePrompt == null) series.satirePrompt = '';

  const nextRun = series.runCount + 1;
  const nextLevel = forceLevel ? parseInt(forceLevel, 10) || nextRun : nextRun;
  const levelIntent = nextLevelLabel(mode, nextLevel);

  console.log(`\n🔎 Enriching source...`);
  const source = await enrichUrl(urlArg);
  console.log(`   Title  : ${source.title}`);
  console.log(`   Chars  : ${source.text.length}`);
  if (source.text.length < 200 || source.text === '[No extractable text]') {
    console.error(
      '🚫 Extract too thin to train on. Not writing a module.\n' +
        '   For X: the headless page never hydrated. This build tries api.fxtwitter.com first.\n' +
        '   If that is also empty, export a logged-in session:\n' +
        '     PLAYWRIGHT_STORAGE=x-storage.json bun course_builder5.js ...'
    );
    process.exit(1);
  }

  const peek = await optionalThreadPeek();
  const user = buildUserPrompt({
    mode,
    spec,
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
  series.lastPromptKind = spec.promptKind;
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
    series[spec.promptField] = parsed.reusable_prompt.slice(0, PROMPT_CHAR_CAP);
  }
  series.priorOutputs = series.priorOutputs || [];
  series.priorOutputs.push({
    run: nextRun,
    level: nextLevel,
    mode,
    promptKind: spec.promptKind,
    moduleTitle,
    file: runPath,
    source: source.url,
    at: new Date().toISOString(),
  });
  series.updatedAt = new Date().toISOString();

  await fs.writeFile(path.join(seriesDir, 'index.md'), buildIndexMarkdown(series), 'utf8');
  const promptBody = buildPromptMarkdown(series, spec.promptKind, spec.promptField);
  await fs.writeFile(path.join(seriesDir, '_prompt.md'), promptBody, 'utf8');
  if (publishPrompt) {
    await fs.writeFile(path.join(seriesDir, 'prompt.md'), promptBody, 'utf8');
  }

  await saveCourseModel(model);

  console.log(`\n✅ ${runPath}`);
  console.log(`✅ ${path.join(seriesDir, 'index.md')} (date frozen at ${series.createdAt})`);
  console.log(`✅ ${path.join(seriesDir, '_prompt.md')} (${spec.promptKind})`);
  if (publishPrompt) console.log(`✅ ${path.join(seriesDir, 'prompt.md')} public`);
  console.log(`✅ ${MODEL_PATH}`);
  console.log(`   run ${nextRun} · concepts ${series.keyConcepts.length} · techniques ${series.techniques.length}`);
}

main().catch((err) => {
  console.error('Fatal course_builder5 error:', err);
  process.exit(1);
});

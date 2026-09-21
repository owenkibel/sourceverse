#!/usr/bin/env bun
/**
 * classify-slice.js
 *
 * One taxonomy pass over a small URL list. Does not write courses or rewrites.
 * Purpose: pick --title and --as for voice_rewrite / course_builder, and skip
 * the rest. Most URLs should be skip.
 *
 *   bun classify-slice.js --file=urls.txt
 *   bun classify-slice.js --url="https://..." --url="https://..."
 *   bun classify-slice.js --file=urls.txt --out=stamps/devine-pass
 *
 * Optional:
 *   --model=grok-4.6
 *   --dry-run
 *
 * Reads series names from cumulative_course_model.json when present.
 * Writes <out>.jsonl and <out>.md (default stamps/stamps-<stamp>).
 */

import fs from 'fs/promises';
import path from 'path';
import ogs from 'open-graph-scraper';

const MODEL_PATH = 'cumulative_course_model.json';
const DEFAULT_MODEL = process.env.XAI_MODEL || 'grok-4.7';
const SNIPPET_CAP = 280;
const MAX_URLS = 24;

const args = process.argv.slice(2);
const fileArg = args.find((a) => a.startsWith('--file='))?.slice(7);
const outArg = args.find((a) => a.startsWith('--out='))?.slice(6);
const modelArg = args.find((a) => a.startsWith('--model='))?.slice(8);
const dryRun = args.includes('--dry-run');
const urlArgs = args.filter((a) => a.startsWith('--url=')).map((a) => a.slice(6).trim()).filter(Boolean);

const KNOWN_DEFAULTS = [
  { slug: 'demagoguery-101', title: 'Demagoguery 101', kinds: ['analyst'] },
  { slug: 'snark-101', title: 'Snark 101', kinds: ['craft', 'analyst'] },
  { slug: 'humor-101', title: 'Humor 101', kinds: ['humor'] },
  { slug: 'satire-101', title: 'Satire 101', kinds: ['satire'] },
  { slug: 'black-101', title: 'Black 101', kinds: ['craft'] },
  { slug: 'devine-101', title: 'Devine 101', kinds: ['craft', 'analyst'] },
];

function yamlString(value) {
  return JSON.stringify(value == null ? '' : String(value));
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isXUrl(url) {
  const h = hostOf(url);
  return h === 'x.com' || h === 'twitter.com' || h === 'mobile.twitter.com';
}

function xStatusId(url) {
  const m = String(url).match(/status\/(\d+)/);
  return m ? m[1] : null;
}

function formGuess(url) {
  const h = hostOf(url);
  const u = String(url).toLowerCase();
  if (/forecast\.weather\.gov|weather\.gov\/product/.test(u)) return 'instrument';
  if (/whitehouse\.gov\/(fact-sheets|presidential-actions|briefing-room)/.test(u)) return 'instrument';
  if (/federalregister\.gov|govinfo\.gov/.test(u)) return 'instrument';
  if (isXUrl(url)) return 'x-short';
  if (/youtube\.com|youtu\.be/.test(h)) return 'youtube-talk';
  if (/nytimes|washingtonpost|wsj\.com|ft\.com|bloomberg|economist|newyorker|theatlantic/.test(h)) {
    return 'paywall';
  }
  if (/nypost\.com\/.*\/opinion\//.test(u) || /nationalreview|thefp\.com|compactmag/.test(h)) {
    return 'signed-column';
  }
  if (/apnews|reuters|semafor|politico|thehill|axios/.test(h)) return 'wire';
  return 'page';
}

function tweetText(t) {
  return String(t?.text || t?.full_text || '').trim();
}

function tweetHandle(t) {
  return String(t?.author?.screen_name || t?.user_screen_name || t?.authorName || '').toLowerCase();
}

function packFxTweet(tweet, extraText = '', kind = 'x-fx') {
  const text = tweetText(tweet);
  if (!text) return null;
  const author = tweet.author?.name || tweet.user_name || tweet.authorName || '';
  const handle = tweet.author?.screen_name || tweet.user_screen_name || '';
  const quote = tweet.quote || tweet.quoted_tweet || tweet.quoted_status;
  const quoteText = quote
    ? `\n\nQuoted:\n${quote.author?.name || quote.user_name || ''} ${tweetText(quote)}`.trim()
    : '';
  return {
    ogTitle: [author, handle && `@${handle}`].filter(Boolean).join(' ') || 'X post',
    ogDescription: [text + quoteText, extraText].filter(Boolean).join('\n\n'),
    kind,
  };
}

async function fetchXViaFx(url) {
  const id = xStatusId(url);
  if (!id) return null;

  try {
    const res = await fetch(`https://api.fxtwitter.com/2/thread/${id}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 Sourceverse-fx-thread' },
      signal: AbortSignal.timeout(12000),
    });
    if (res.ok) {
      const data = await res.json();
      const parts = data.thread || data.tweets || [];
      if (parts.length > 1) {
        const root = parts[0];
        const handle = tweetHandle(root);
        const same = parts.filter((p) => !handle || tweetHandle(p) === handle);
        const body = same.map(tweetText).filter(Boolean).join('\n\n');
        if (body.length > tweetText(root).length) {
          const packed = packFxTweet(root, '', 'x-fx-thread');
          if (packed) {
            packed.ogDescription = body;
            packed.threadCount = same.length;
            return packed;
          }
        }
      }
    }
  } catch (err) {
    console.warn(`  fx thread failed: ${err.message}`);
  }

  const endpoints = [
    `https://api.fxtwitter.com/status/${id}`,
    `https://api.vxtwitter.com/Twitter/status/${id}`,
  ];
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep, {
        headers: { 'User-Agent': 'Mozilla/5.0 Sourceverse-fx' },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const packed = packFxTweet(data.tweet || data, '', 'x-fx');
      if (packed) return packed;
    } catch (err) {
      console.warn(`  fx/vx ${ep} failed: ${err.message}`);
    }
  }
  return null;
}

async function peekUrl(url) {
  const guessed = formGuess(url);
  let title = url;
  let snippet = '';
  let chars = 0;

  if (isXUrl(url)) {
    const fx = await fetchXViaFx(url);
    if (fx) {
      return { url, host: hostOf(url), formHint: fx.chars < 400 ? 'x-short' : 'x-long', ...fx };
    }
  }

  try {
    const { result } = await ogs({ url, timeout: 10000 });
    title = result?.ogTitle || result?.twitterTitle || title;
    snippet = String(result?.ogDescription || result?.twitterDescription || '').slice(0, SNIPPET_CAP);
    chars = snippet.length;
  } catch (err) {
    snippet = `(ogs failed: ${err.message})`;
  }

  return { url, host: hostOf(url), title, snippet, chars, formHint: guessed };
}

async function loadSeriesCatalog() {
  const fromFile = [];
  try {
    const raw = JSON.parse(await fs.readFile(MODEL_PATH, 'utf8'));
    const bag = raw.series || raw.courses || {};
    for (const [slug, s] of Object.entries(bag)) {
      const kinds = [];
      if (s.craftPrompt) kinds.push('craft');
      if (s.analystPrompt) kinds.push('analyst');
      if (s.humorPrompt) kinds.push('humor');
      if (s.satirePrompt) kinds.push('satire');
      fromFile.push({
        slug,
        title: s.title || slug,
        kinds: kinds.length ? kinds : ['craft', 'analyst'],
      });
    }
  } catch {
    /* use defaults */
  }
  const seen = new Set(fromFile.map((s) => s.slug));
  for (const d of KNOWN_DEFAULTS) {
    if (!seen.has(d.slug)) fromFile.push(d);
  }
  return fromFile;
}

async function readUrlList() {
  const out = [...urlArgs];
  if (fileArg) {
    const raw = await fs.readFile(fileArg, 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const m = t.match(/https?:\/\/\S+/);
      if (m) out.push(m[0].replace(/[)>,]+$/, ''));
    }
  }
  return [...new Set(out)].slice(0, MAX_URLS);
}

function parseJsonBlock(raw) {
  const text = String(raw || '').replace(/```json|```/g, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('classifier returned no JSON array');
  return JSON.parse(text.slice(start, end + 1));
}

function normalizeStamp(item, peeks, catalog) {
  const url = String(item.url || '').trim();
  const peek = peeks.find((p) => p.url === url) || {};
  const slugs = new Set(catalog.map((s) => s.slug));
  let series = Array.isArray(item.series) ? item.series : item.series ? [item.series] : [];
  series = series.map((s) => String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-')).filter((s) => slugs.has(s));
  let rewrite = String(item.rewrite || 'skip').toLowerCase();
  if (!['skip', 'analyst', 'craft', 'humor', 'satire'].includes(rewrite)) rewrite = 'skip';
  let train = String(item.train || 'skip').toLowerCase();
  if (!['skip', 'prompt', 'course', 'humor', 'satire'].includes(train)) train = 'skip';
  const form = String(item.form || peek.formHint || 'page');
  if (form === 'instrument' || form === 'paywall' && (peek.chars || 0) < 120) {
    if (rewrite === 'craft') rewrite = 'analyst';
  }
  if (form === 'x-short' && rewrite === 'craft') rewrite = 'skip';
  if (!series.length) {
    rewrite = 'skip';
    train = 'skip';
  }
  const title = series[0] ? catalog.find((s) => s.slug === series[0])?.title || series[0] : '';
  return {
    url,
    host: peek.host || hostOf(url),
    pageTitle: peek.title || '',
    form,
    train,
    rewrite,
    series,
    title,
    as: rewrite === 'skip' ? '' : rewrite,
    confidence: Number(item.confidence) || 0,
    why: String(item.why || '').slice(0, 180),
  };
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
      model: modelArg || DEFAULT_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.4,
      max_tokens: 2500,
      reasoning_effort: 'low',
    }),
  });
  if (!response.ok) throw new Error(`xAI API ${response.status}: ${await response.text()}`);
  const data = await response.json();
  const msg = data.choices?.[0]?.message;
  return (msg?.content || msg?.reasoning_content || '').trim();
}

function buildMarkdown(stamps) {
  const keep = stamps.filter((s) => s.rewrite !== 'skip' || s.train !== 'skip');
  const rows = (keep.length ? keep : stamps)
    .map((s) => {
      const cmd =
        s.rewrite !== 'skip' && s.title
          ? `bun voice_rewrite.js --url=${yamlString(s.url)} --title=${yamlString(s.title)} --as=${s.as}`
          : '—';
      return `| ${s.form} | ${s.rewrite} | ${s.train} | ${(s.series || []).join(', ') || '—'} | ${s.why || ''} | ${cmd} |`;
    })
    .join('\n');
  return `# URL stamps

Most URLs should be skip. Keepers only.

| form | --as | train | --title | why | command |
|---|---|---|---|---|---|
${rows}
`;
}

async function main() {
  const urls = await readUrlList();
  if (!urls.length) {
    console.error('Pass --file=urls.txt and/or --url=https://...');
    process.exit(1);
  }

  const catalog = await loadSeriesCatalog();
  console.log(`🔖 classify-slice · ${urls.length} urls · series ${catalog.map((s) => s.slug).join(', ')}`);

  const peeks = [];
  for (const url of urls) {
    process.stdout.write(`  peek ${hostOf(url)} ... `);
    const p = await peekUrl(url);
    peeks.push(p);
    console.log(`${p.formHint} · ${p.chars}c`);
  }

  const catalogLines = catalog
    .map((s) => `- ${s.slug} (${s.title}) kinds: ${s.kinds.join(', ')}`)
    .join('\n');

  const peekBlock = peeks
    .map(
      (p, i) =>
        `${i + 1}. ${p.url}\n   host: ${p.host}\n   formHint: ${p.formHint}\n   title: ${p.title}\n   chars: ${p.chars}\n   snippet: ${p.snippet}`
    )
    .join('\n\n');

  const system = `You classify URLs for a small rewrite/course pipeline. You do not write columns.
Return ONLY a JSON array. One object per input URL, same order.

Each object:
{"url":"...","form":"instrument|wire|signed-column|x-short|x-long|youtube-talk|paywall|page|noise","train":"skip|prompt|course|humor|satire","rewrite":"skip|analyst|craft|humor|satire","series":["slug"],"confidence":0.0,"why":"≤20 words"}

Rules:
- Skip junk, instruments, thin official X, and paywalled stubs.
- If the slice contains any wire, x-long note, or signed column that matches the catalog, mark 1–3 keepers.
- Prefer rewrite=analyst over skip for a process/calendar wire.
- Prefer train=prompt and rewrite=skip when the page IS the trained author (Black writing as Black).
- Do not return an all-skip array when at least one URL is a wire or x-long.
- instrument (fact sheet, AFD, proclamation, FR notice) → rewrite analyst or skip; never craft.
- x-short official posts → skip or analyst; never craft.
- paywall with thin snippet → skip.
- signed-column by a trained desk → series for that desk; train prompt and/or course; rewrite only if someone would actually run voice_rewrite on it (usually skip columns that ARE the desk).
- wire/process story with a calendar, conversion, or official leftover → analyst + demagoguery-101 and/or devine-101 if the conversion matches.
- wire with named harm + official answer → craft possible for devine-101; else analyst.
- long signed argument (Sacks-like, Black-like) → black-101 craft, not Devine.
- Futurism-style tech pejorative → snark-101, usually skip rewrite unless asked.
- comic observation → humor-101; institutional parody → satire-101.
- series must be one of the catalog slugs. Empty series means skip.
- why must cite form, not politics.`;

  const user = `CATALOG\n${catalogLines}\n\nURLS\n${peekBlock}`;

  if (dryRun) {
    console.log('\n🧪 --dry-run: peeks only\n');
    console.log(peekBlock);
    return;
  }

  console.log(`\n🧠 classifying with ${modelArg || DEFAULT_MODEL}...`);
  const raw = await callGrok(system, user);
  const parsed = parseJsonBlock(raw);
  const stamps = parsed.map((item) => normalizeStamp(item, peeks, catalog));

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = outArg || path.join('stamps', `stamps-${stamp}`);
  await fs.mkdir(path.dirname(base) === '.' ? 'stamps' : path.dirname(base), { recursive: true });
  const jsonlPath = base.endsWith('.jsonl') ? base : `${base}.jsonl`;
  const mdPath = jsonlPath.replace(/\.jsonl$/, '.md');

  await fs.writeFile(jsonlPath, stamps.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');
  await fs.writeFile(mdPath, buildMarkdown(stamps), 'utf8');

  const keepers = stamps.filter((s) => s.rewrite !== 'skip');
  console.log(`✅ ${jsonlPath}`);
  console.log(`✅ ${mdPath}`);
  console.log(`   keepers ${keepers.length}/${stamps.length}`);
  for (const s of keepers) {
    console.log(`   --title="${s.title}" --as=${s.as}  ${s.url}`);
  }
}

main().catch((err) => {
  console.error('Fatal classify-slice error:', err);
  process.exit(1);
});

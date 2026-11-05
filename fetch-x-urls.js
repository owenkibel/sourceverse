import fs from 'fs/promises';
import path from 'path';
import { firefox } from 'playwright';

const DEFAULT_LIMIT = 10;
const DEFAULT_MIN_WORDS = 150;

const slugify = (t) =>
  (t || 'author')
    .toString()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/^-+|-+$/g, '');

// --- CLI Argument Parser ---
const rawArgs = process.argv.slice(2);

let limit = DEFAULT_LIMIT;
let minWords = DEFAULT_MIN_WORDS;
let customOutFile = null;
let explicitAuthorName = null;
let overwriteFile = false;
let usePlaywrightDiscovery = false;
const positional = [];

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg.startsWith('--limit=')) {
    limit = parseInt(arg.split('=')[1], 10) || DEFAULT_LIMIT;
  } else if (arg.startsWith('--min-words=')) {
    minWords = parseInt(arg.split('=')[1], 10) || 0;
  } else if (arg.startsWith('--out=')) {
    customOutFile = arg.split('=').slice(1).join('=').trim();
  } else if (arg.startsWith('--author=')) {
    explicitAuthorName = arg.split('=').slice(1).join('=').trim();
  } else if (arg === '--overwrite' || arg === '--replace') {
    overwriteFile = true;
  } else if (arg === '--browser' || arg === '--playwright') {
    usePlaywrightDiscovery = true;
  } else if (!arg.startsWith('--')) {
    positional.push(arg);
  }
}

function resolveXHandle(input) {
  const clean = (input || '').trim();
  if (!clean) return null;

  const urlMatch = clean.match(/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})/i);
  if (urlMatch) return urlMatch[1];

  return clean.replace(/^@/, '').split(/[/?#]/)[0].trim();
}

function extractFxArticle(t) {
  const art = t?.article;
  if (!art) return null;

  const title = String(art.title || '').trim();
  let body = '';

  if (typeof art.full_text === 'string' && art.full_text.trim().length > 0) {
    body = art.full_text.trim();
  } else if (Array.isArray(art.content?.blocks)) {
    body = art.content.blocks
      .map(b => String(b?.text || '').trim())
      .filter(Boolean)
      .join('\n\n');
  } else if (art.preview_text) {
    body = String(art.preview_text).trim();
  }

  return body ? { title, body } : null;
}

function extractTweetText(t) {
  const art = extractFxArticle(t);
  const stdText = String(t?.text || t?.full_text || '').trim();
  if (art && art.body.length > stdText.length) {
    return {
      text: art.body,
      title: art.title || stdText.slice(0, 75),
      kind: 'x-article'
    };
  }
  const firstLine = stdText.split('\n')[0].replace(/\s+/g, ' ').trim();
  const snippetTitle = firstLine.length > 72 ? `${firstLine.slice(0, 72)}...` : firstLine;
  return {
    text: stdText,
    title: snippetTitle || 'X Post',
    kind: 'x-post'
  };
}

function getStatusId(t) {
  return String(t?.id || t?.id_str || t?.rest_id || '').trim();
}

function getHandle(t) {
  return String(
    t?.author?.screen_name || t?.user_screen_name || t?.author?.handle || ''
  ).toLowerCase();
}

// Enrich a single status ID via /2/thread/:id or /status/:id, strictly enforcing target handle
async function fetchFullStatusOrThread(handle, statusId) {
  const targetHandle = handle.toLowerCase();

  // 1. Try unrolled thread endpoint first
  try {
    const threadRes = await fetch(`https://api.fxtwitter.com/2/thread/${statusId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 Sourceverse-X-Fetcher' },
      signal: AbortSignal.timeout(12000)
    });
    if (threadRes.ok) {
      const data = await threadRes.json();
      const parts = data.thread || data.tweets || [];
      if (parts.length > 1) {
        const root = parts[0];
        const rootHandle = getHandle(root);

        // Reject threads started by someone else (e.g. replies to or retweets of other users)
        if (rootHandle && rootHandle !== targetHandle) {
          return null;
        }

        const sameAuthorParts = parts.filter(p => getHandle(p) === targetHandle);
        if (sameAuthorParts.length === 0) return null;

        const firstPart = sameAuthorParts[0];
        const lastPart = sameAuthorParts[sameAuthorParts.length - 1];
        const rootId = getStatusId(firstPart) || statusId;
        const tailId = getStatusId(lastPart) || statusId;
        const allIds = sameAuthorParts.map(getStatusId).filter(Boolean);

        const combinedText = sameAuthorParts
          .map(p => extractTweetText(p).text)
          .filter(Boolean)
          .join('\n\n');

        const rootMeta = extractTweetText(firstPart);
        return {
          rootId,
          tailId,
          allIds,
          authorName: firstPart.author?.name || explicitAuthorName || handle,
          handle: firstPart.author?.screen_name || handle,
          createdAt: firstPart.created_at || firstPart.createdAt || null,
          title: rootMeta.title,
          text: combinedText,
          kind:
            rootMeta.kind === 'x-article'
              ? 'x-article'
              : sameAuthorParts.length > 1
              ? `x-thread(${sameAuthorParts.length})`
              : 'x-post'
        };
      }
    }
  } catch (_) {}

  // 2. Single status / X Article lookup
  for (const ep of [
    `https://api.fxtwitter.com/${handle}/status/${statusId}`,
    `https://api.fxtwitter.com/2/status/${statusId}`
  ]) {
    try {
      const res = await fetch(ep, {
        headers: { 'User-Agent': 'Mozilla/5.0 Sourceverse-X-Fetcher' },
        signal: AbortSignal.timeout(12000)
      });
      if (!res.ok) continue;
      const data = await res.json();
      const t = data.tweet || data.status || data;
      if (!t) continue;

      // Reject single posts/reposts authored by other accounts
      const postHandle = getHandle(t);
      if (postHandle && postHandle !== targetHandle) {
        return null;
      }

      const extracted = extractTweetText(t);
      if (!extracted.text) continue;

      const id = getStatusId(t) || statusId;
      return {
        rootId: id,
        tailId: id,
        allIds: [id],
        authorName: t.author?.name || explicitAuthorName || handle,
        handle: t.author?.screen_name || handle,
        createdAt: t.created_at || t.createdAt || null,
        title: extracted.title,
        text: extracted.text,
        kind: extracted.kind
      };
    } catch (_) {}
  }

  return null;
}

// Primary Discovery: FxTwitter v2 User Timeline API (/2/profile/:handle/statuses)
async function discoverTimelineViaFxApi(handle, maxCandidates = 75) {
  const candidates = [];
  const targetHandle = handle.toLowerCase();
  let cursor = null;

  for (let page = 0; page < 5 && candidates.length < maxCandidates; page++) {
    const url = new URL(`https://api.fxtwitter.com/2/profile/${handle}/statuses`);
    if (cursor) url.searchParams.set('cursor', cursor);

    try {
      const res = await fetch(url.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 Sourceverse-X-Timeline',
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) break;
      const data = await res.json();

      const list =
        data.statuses ||
        data.tweets ||
        data.results ||
        data.timeline ||
        (Array.isArray(data.data) ? data.data : []);

      if (!Array.isArray(list) || list.length === 0) break;

      for (const item of list) {
        const t = item.tweet || item;
        // Skip retweets/reposts where the tweet author is someone else
        if (t.retweeted_status || t.repost || /^RT @/i.test(t.text || '')) continue;
        const itemHandle = getHandle(t);
        if (itemHandle && itemHandle !== targetHandle) continue;

        const id = getStatusId(t);
        if (id) candidates.push({ id, rawTweet: t });
      }

      cursor =
        data.cursor?.bottom ||
        data.next_cursor ||
        data.cursor ||
        data.pagination?.next_cursor ||
        null;
      if (!cursor) break;
    } catch (_) {
      break;
    }
  }

  return candidates;
}

// Fallback Discovery: Scroll https://x.com/:handle in Headless Firefox
async function discoverTimelineViaPlaywright(handle, scrollPasses = 8) {
  console.log(`   🌐 Scanning https://x.com/${handle} via headless Firefox for recent status IDs...`);
  const browser = await firefox.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`https://x.com/${handle}`, {
      waitUntil: 'domcontentloaded',
      timeout: 25000
    });
    await page.waitForTimeout(2500);

    const discoveredIds = new Set();
    const handleLower = handle.toLowerCase();

    for (let i = 0; i < scrollPasses; i++) {
      const idsOnScreen = await page.evaluate((targetHandle) => {
        const links = Array.from(document.querySelectorAll('a[href*="/status/"]'));
        const results = [];
        for (const a of links) {
          const href = a.getAttribute('href') || '';
          const m = href.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)/);
          if (m && m[1].toLowerCase() === targetHandle) {
            results.push(m[2]);
          }
        }
        return results;
      }, handleLower);

      idsOnScreen.forEach(id => discoveredIds.add(id));
      await page.evaluate(() => window.scrollBy(0, 1400));
      await page.waitForTimeout(900);
    }

    await context.close();
    return [...discoveredIds].map(id => ({ id, rawTweet: null }));
  } finally {
    await browser.close();
  }
}

async function main() {
  const targetInput = positional.join(' ').trim();
  if (!targetInput) {
    console.log(`Usage:
  bun fetch-x-urls.js shellenberger --author="Michael Shellenberger" --min-words=180 --overwrite
  bun fetch-x-urls.js ConradMBlack --author="Conrad Black" --min-words=150 --overwrite

Options:
  --author="Name"   Author name for profile & output filename
  --min-words=N     Minimum word count for long X posts/threads/articles (default: ${DEFAULT_MIN_WORDS})
  --limit=N         Max qualifying long X URLs to collect (default: ${DEFAULT_LIMIT})
  --out=FILE        Custom output file (default: <author-slug>-x-urls.txt)
  --browser         Force Playwright profile scroll to discover status IDs
  --overwrite       Replace the output file instead of appending`);
    process.exit(1);
  }

  const handle = resolveXHandle(targetInput);
  console.log(
    `\n📡 Scanning X account @${handle} for long posts, threads & X Articles (min-words: ${minWords})...`
  );

  let candidates = [];
  if (!usePlaywrightDiscovery) {
    candidates = await discoverTimelineViaFxApi(handle, limit * 7);
  }
  if (candidates.length === 0) {
    candidates = await discoverTimelineViaPlaywright(handle, 10);
  }

  if (candidates.length === 0) {
    console.log(`⚠️ Could not discover recent statuses for @${handle}.`);
    process.exit(0);
  }

  console.log(`   🔍 Evaluating ${candidates.length} candidate status(es) authored by @${handle}...`);

  const collected = [];
  const seenStatusIds = new Set();
  const seenRootIds = new Set();
  let skippedShortCount = 0;

  for (const cand of candidates) {
    if (collected.length >= limit) break;
    if (seenStatusIds.has(cand.id)) continue;

    const enriched = await fetchFullStatusOrThread(handle, cand.id);
    if (!enriched || !enriched.text) continue;

    // Deduplicate if another tweet from this same root thread was already collected
    if (seenRootIds.has(enriched.rootId)) {
      seenStatusIds.add(cand.id);
      (enriched.allIds || []).forEach(id => seenStatusIds.add(id));
      continue;
    }

    seenRootIds.add(enriched.rootId);
    seenStatusIds.add(cand.id);
    seenStatusIds.add(enriched.rootId);
    seenStatusIds.add(enriched.tailId);
    (enriched.allIds || []).forEach(id => seenStatusIds.add(id));

    const cleanText = enriched.text
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const charLength = cleanText.length;
    const wordCount = cleanText ? cleanText.split(/\s+/).length : 0;

    if (minWords > 0 && wordCount < minWords) {
      skippedShortCount++;
      continue;
    }

    let isoDate = new Date().toISOString().slice(0, 10);
    if (enriched.createdAt) {
      const d = new Date(enriched.createdAt);
      if (!isNaN(d.getTime())) isoDate = d.toISOString().slice(0, 10);
    }

    // Use tailId in the URL so /2/thread/:id in grow-verse-profile.js & generate-links8.js
    // walks upward to rootId and unrolls the full thread in a single API call:
    collected.push({
      rootId: enriched.rootId,
      tailId: enriched.tailId,
      url: `https://x.com/${enriched.handle}/status/${enriched.tailId}`,
      date: isoDate,
      title: enriched.title.replace(/\s+/g, ' ').trim(),
      wordCount,
      charLength,
      kind: enriched.kind,
      authorName: explicitAuthorName || enriched.authorName || handle
    });
  }

  if (skippedShortCount > 0) {
    console.log(`   ℹ️ Discarded ${skippedShortCount} short X post(s) under ${minWords} words.`);
  }

  if (collected.length === 0) {
    console.log(
      `⚠️ No X posts on @${handle} met --min-words=${minWords}. Try lowering --min-words=80 or adding --browser.`
    );
    process.exit(0);
  }

  const resolvedAuthor = explicitAuthorName || collected[0].authorName || handle;
  const fileSlug = slugify(resolvedAuthor);
  const outputFilePath = path.resolve(
    process.cwd(),
    customOutFile || `${fileSlug}-x-urls.txt`
  );

  let existingContent = '';
  const existingUrls = new Set();

  if (!overwriteFile) {
    try {
      existingContent = await fs.readFile(outputFilePath, 'utf8');
      existingContent
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'))
        .forEach(u => existingUrls.add(u));
    } catch (_) {}
  }

  const newPosts = collected.filter(p => !existingUrls.has(p.url));
  if (newPosts.length === 0) {
    console.log(
      `ℹ️ Found ${collected.length} qualifying X post(s), but all are already in ${path.basename(outputFilePath)} (use --overwrite to replace).`
    );
    process.exit(0);
  }

  const linesToWrite = [];
  if (!existingContent || overwriteFile) {
    linesToWrite.push(
      `# X (Twitter) Long-Form Training URLs for ${resolvedAuthor} (@${handle}) (${new Date().toISOString().slice(0, 10)})`,
      `# Source: https://x.com/${handle} (min-words: ${minWords})`,
      `# Delete or '#' comment out any unsuitable URL lines before running grow-verse-profile.js`,
      ``
    );
  } else {
    linesToWrite.push(
      ``,
      `# Appended X slice (${new Date().toISOString().slice(0, 10)})`
    );
  }

  console.log(`\n🔎 Retrieved ${newPosts.length} long-form X post(s) for ${resolvedAuthor} (@${handle}):\n`);

  newPosts.forEach((p, idx) => {
    const idLabel = p.tailId !== p.rootId ? `root:${p.rootId}->tail:${p.tailId}` : `id:${p.rootId}`;
    const metrics = [idLabel, `${p.wordCount}w`, `${p.charLength} chars`, p.kind].join(', ');
    console.log(`  ${idx + 1}. [${p.date}] ${p.title} (${metrics})\n     ${p.url}`);
    linesToWrite.push(`# [${p.date}] ${p.title} (${metrics})`);
    linesToWrite.push(p.url);
  });

  const payload = linesToWrite.join('\n') + '\n';
  if (overwriteFile) {
    await fs.writeFile(outputFilePath, payload, 'utf8');
  } else {
    await fs.appendFile(outputFilePath, payload, 'utf8');
  }

  console.log(`\n======================================================================`);
  console.log(`✅ ${overwriteFile ? 'Wrote' : 'Appended'} ${newPosts.length} long-form X URL(s) to: ${outputFilePath}`);
  console.log(`👉 Train dedicated X profile with:`);
  console.log(`   bun grow-verse-profile.js --author="${resolvedAuthor} X" --urls-file=${path.basename(outputFilePath)}`);
  console.log(`======================================================================\n`);
}

main().catch(err => {
  console.error('Fatal error in fetch-x-urls:', err.message);
  process.exit(1);
});
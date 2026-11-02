import fs from 'fs/promises';
import path from 'path';
import { convert } from 'html-to-text';

const DEFAULT_LIMIT = 10;
const DEFAULT_MIN_WORDS = 200;

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
let includePaid = false;
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
  } else if (arg === '--include-paid') {
    includePaid = true;
  } else if (!arg.startsWith('--')) {
    positional.push(arg);
  }
}

function resolveMediumFeedUrls(input) {
  const clean = (input || '').trim().toLowerCase();
  if (!clean) return [];

  // 1. Handle full URLs (e.g. https://avi-loeb.medium.com/ or https://medium.com/@avi-loeb)
  if (clean.startsWith('http://') || clean.startsWith('https://')) {
    try {
      const parsed = new URL(clean);
      if (parsed.hostname.endsWith('.medium.com')) {
        const handle = parsed.hostname.replace(/\.medium\.com$/, '');
        return [
          `https://${parsed.hostname}/feed`,
          `https://medium.com/feed/@${handle}`
        ];
      }
      const atMatch = parsed.pathname.match(/\/@([a-z0-9_.-]+)/i);
      if (atMatch) {
        return [
          `https://medium.com/feed/@${atMatch[1]}`,
          `https://${atMatch[1]}.medium.com/feed`
        ];
      }
    } catch (_) {}
  }

  // 2. Handle @handle or subdomain or plain name ("avi-loeb" / "Avi Loeb")
  const handle = clean
    .replace(/^@/, '')
    .replace(/\.medium\.com.*$/, '')
    .trim()
    .replace(/\s+/g, '-');

  return [
    `https://${handle}.medium.com/feed`,
    `https://medium.com/feed/@${handle}`
  ];
}

function extractXmlTag(block, tagName) {
  const regex = new RegExp(
    `<${tagName}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tagName}>`,
    'i'
  );
  const m = block.match(regex);
  if (!m) return '';
  return (m[1] !== undefined ? m[1] : m[2] || '').trim();
}

function cleanMediumUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    const parsed = new URL(rawUrl.trim());
    return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '');
  } catch {
    return rawUrl.split('?')[0].replace(/\/$/, '');
  }
}

async function fetchMediumFeed(feedUrls, maxItems, minWordCount) {
  let xml = '';
  let activeFeedUrl = '';

  for (const url of feedUrls) {
    try {
      const res = await fetch(`${url}?_t=${Date.now()}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Sourceverse-Medium-Reader/1.0',
          'Accept': 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
          'Cache-Control': 'no-cache'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000)
      });
      if (res.ok) {
        const text = await res.text();
        if (text.includes('<rss') && text.includes('<item>')) {
          xml = text;
          activeFeedUrl = url;
          break;
        }
      }
    } catch (_) {}
  }

  if (!xml) {
    throw new Error(`Could not retrieve a valid Medium RSS XML feed from: ${feedUrls.join(' or ')}`);
  }

  const itemBlocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(m => m[1]);
  const collected = [];
  const seenIds = new Set();
  const seenUrls = new Set();
  const seenTitleAndLength = new Set();

  for (const block of itemBlocks) {
    if (collected.length >= maxItems) break;

    const rawTitle = extractXmlTag(block, 'title');
    const rawLink = extractXmlTag(block, 'link');
    const guid = extractXmlTag(block, 'guid');
    const creator = extractXmlTag(block, 'dc:creator');
    const pubDateRaw = extractXmlTag(block, 'pubDate');
    const contentHtml =
      extractXmlTag(block, 'content:encoded') ||
      extractXmlTag(block, 'description');

    const canonicalUrl = cleanMediumUrl(rawLink);
    const postIdMatch = guid.match(/\/p\/([a-f0-9]+)/i) || canonicalUrl.match(/-([a-f0-9]{8,12})$/i);
    const postId = postIdMatch ? postIdMatch[1] : canonicalUrl;

    if (!canonicalUrl || seenIds.has(postId) || seenUrls.has(canonicalUrl)) {
      continue;
    }

    // Detect Medium Partner Program paywall truncation inside the RSS item
    const isPaywalledTruncated =
      contentHtml.includes('medium-feed-snippet') ||
      /Continue reading on Medium\s*»/i.test(contentHtml);

    if (!includePaid && isPaywalledTruncated) {
      continue;
    }

    const plainText = convert(contentHtml, { wordwrap: false })
      .replace(/\s+/g, ' ')
      .trim();

    const charLength = plainText.length;
    const wordCount = plainText ? plainText.split(/\s+/).length : 0;

    if (minWordCount > 0 && wordCount < minWordCount) {
      continue;
    }

    const normTitle = rawTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
    const lengthFingerprint = `${normTitle}:${wordCount}`;
    if (seenTitleAndLength.has(lengthFingerprint)) {
      continue;
    }

    seenIds.add(postId);
    seenUrls.add(canonicalUrl);
    seenTitleAndLength.add(lengthFingerprint);

    let isoDate = new Date().toISOString().slice(0, 10);
    if (pubDateRaw) {
      const parsedDate = new Date(pubDateRaw);
      if (!isNaN(parsedDate.getTime())) {
        isoDate = parsedDate.toISOString().slice(0, 10);
      }
    }

    collected.push({
      id: postId,
      title: rawTitle || 'Untitled',
      url: canonicalUrl,
      date: isoDate,
      wordCount,
      charLength,
      audience: isPaywalledTruncated ? 'member_only' : 'public',
      authorName: creator || explicitAuthorName || 'Medium Author',
      feedSource: activeFeedUrl
    });
  }

  return collected;
}

async function main() {
  const targetInput = positional.join(' ').trim();
  if (!targetInput && !explicitAuthorName) {
    console.log(`Usage:
  bun fetch-medium-urls.js avi-loeb --author="Avi Loeb" --overwrite
  bun fetch-medium-urls.js https://avi-loeb.medium.com/ --author="Avi Loeb" --overwrite

Options:
  --limit=N         Number of recent essays to fetch (default: ${DEFAULT_LIMIT}, max 10 via RSS)
  --min-words=N     Skip short responses/blurbs under N words (default: ${DEFAULT_MIN_WORDS})
  --include-paid    Include paywalled member-only snippets (skipped by default)
  --author="Name"   Author name for profile & output slug
  --out=FILE        Custom output file (default: <author-slug>-urls.txt)
  --overwrite       Replace the output file instead of appending`);
    process.exit(1);
  }

  const candidateFeeds = resolveMediumFeedUrls(targetInput || explicitAuthorName);
  console.log(`\n📡 Querying Medium RSS feed: ${candidateFeeds[0]} ...`);

  const posts = await fetchMediumFeed(candidateFeeds, limit, minWords);
  if (posts.length === 0) {
    console.log(`⚠️ No full-text public Medium posts found matching criteria.`);
    process.exit(0);
  }

  const resolvedAuthor = explicitAuthorName || posts[0].authorName;
  const fileSlug = slugify(resolvedAuthor);
  const outputFilePath = path.resolve(
    process.cwd(),
    customOutFile || `${fileSlug}-urls.txt`
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
        .forEach(u => existingUrls.add(cleanMediumUrl(u)));
    } catch (_) {}
  }

  const newPosts = posts.filter(p => !existingUrls.has(p.url));
  if (newPosts.length === 0) {
    console.log(
      `ℹ️ Fetched ${posts.length} recent essay(s), but all are already in ${path.basename(outputFilePath)} (use --overwrite to replace).`
    );
    process.exit(0);
  }

  const linesToWrite = [];
  if (!existingContent || overwriteFile) {
    linesToWrite.push(
      `# Medium Training URLs for ${resolvedAuthor} (${new Date().toISOString().slice(0, 10)})`,
      `# Source Feed: ${posts[0].feedSource} (min-words: ${minWords}, public-only: ${!includePaid})`,
      `# Delete or '#' comment out any unsuitable URL lines before running grow-verse-profile.js`,
      ``
    );
  } else {
    linesToWrite.push(
      ``,
      `# Appended Medium slice (${new Date().toISOString().slice(0, 10)})`
    );
  }

  console.log(`\n🔎 Retrieved ${newPosts.length} unique full-text Medium essay(s) for ${resolvedAuthor}:\n`);

  newPosts.forEach((p, idx) => {
    const metrics = [`id:${p.id}`, `${p.wordCount}w`, `${p.charLength} chars`, p.audience].join(', ');
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
  console.log(`✅ ${overwriteFile ? 'Wrote' : 'Appended'} ${newPosts.length} canonical Medium URL(s) to: ${outputFilePath}`);
  console.log(`👉 Train profile with:`);
  console.log(`   bun grow-verse-profile.js --author="${resolvedAuthor}" --urls-file=${path.basename(outputFilePath)}`);
  console.log(`======================================================================\n`);
}

main().catch(err => {
  console.error('Fatal error in fetch-medium-urls:', err.message);
  process.exit(1);
});
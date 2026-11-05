import fs from 'fs/promises';
import path from 'path';
import ogs from 'open-graph-scraper';

const DEFAULT_LIMIT = 7;
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
let searchFilter = '';
let overwriteFile = false;
let verifyCharLength = false;
let includePaid = false;
let includeAudio = false;
let anyAuthor = false;
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
  } else if (arg.startsWith('--search=')) {
    searchFilter = arg.split('=').slice(1).join('=').trim();
  } else if (arg === '--overwrite' || arg === '--replace') {
    overwriteFile = true;
  } else if (arg === '--probe-chars') {
    verifyCharLength = true;
  } else if (arg === '--include-paid') {
    includePaid = true;
  } else if (arg === '--include-audio') {
    includeAudio = true;
  } else if (arg === '--any-author') {
    anyAuthor = true;
  } else if (!arg.startsWith('--')) {
    positional.push(arg);
  }
}

function resolveSubstackHost(input) {
  const clean = (input || '').trim().toLowerCase();
  if (!clean) return null;

  const handleMatch = clean.match(/(?:substack\.com\/@|^@)([a-z0-9_-]+)/i);
  if (handleMatch) {
    return `${handleMatch[1]}.substack.com`;
  }

  if (clean.startsWith('http://') || clean.startsWith('https://')) {
    try {
      return new URL(clean).hostname;
    } catch (_) {}
  }

  if (!clean.includes('.')) {
    return `${clean.replace(/[^a-z0-9]/g, '')}.substack.com`;
  }

  return clean.replace(/\/.*$/, '');
}

function matchesTargetAuthor(post, targetAuthor) {
  if (!targetAuthor || anyAuthor) return true;
  const bylines = post.publishedBylines || [];
  if (bylines.length === 0) return true;

  const targetLower = targetAuthor.toLowerCase().trim();
  const targetSlug = slugify(targetAuthor).replace(/-/g, '');

  return bylines.some((b) => {
    const name = (b.name || '').toLowerCase().trim();
    const handle = (b.handle || '').toLowerCase().trim();
    const nameSlug = slugify(name).replace(/-/g, '');
    return (
      name.includes(targetLower) ||
      targetLower.includes(name) ||
      handle === targetSlug ||
      nameSlug === targetSlug
    );
  });
}

async function probeArticleCharLength(url) {
  try {
    const { html } = await ogs({ url, timeout: 10000 });
    if (!html) return 0;
    const bodyMatch =
      html.match(/<article[\s\S]*?>([\s\S]*?)<\/article>/i) ||
      html.match(/<main[\s\S]*?>([\s\S]*?)<\/main>/i);
    const raw = bodyMatch ? bodyMatch[1] : html;
    const textOnly = raw
      .replace(/<(script|style|nav|footer|header)[\s\S]*?>[\s\S]*?<\/\1>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return textOnly.length;
  } catch {
    return 0;
  }
}

async function fetchSubstackArchive(initialHost, maxItems, minWordCount) {
  const collected = [];
  const seenIds = new Set();
  const seenUrls = new Set();
  const seenNormalizedTitles = new Set();
  const seenTitleAndLength = new Set();

  let activeHost = initialHost;
  let offset = 0;
  // Substack /api/v1/archive supports up to limit=50 per request
  const pageSize = 50;
  const maxOffset = explicitAuthorName ? 800 : 200;
  let skippedPaidForAuthor = 0;

  // Use explicit --search= if provided
  const encodedSearch = encodeURIComponent(searchFilter);

  while (collected.length < maxItems && offset < maxOffset) {
    const apiUrl = `https://${activeHost}/api/v1/archive?sort=new&search=${encodedSearch}&offset=${offset}&limit=${pageSize}&_t=${Date.now()}`;
    const res = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Sourceverse-Substack-Fetcher',
        'Accept': 'application/json',
        'Cache-Control': 'no-cache'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000)
    });

    if (!res.ok) {
      throw new Error(`Substack API returned HTTP ${res.status} for ${apiUrl}`);
    }

    const posts = await res.json();
    if (!Array.isArray(posts) || posts.length === 0) break;

    for (const post of posts) {
      if (collected.length >= maxItems) break;

      const postId = post.id;
      const canonicalUrl =
        post.canonical_url ||
        (post.slug ? `https://${activeHost}/p/${post.slug}` : null);

      if (canonicalUrl && offset === 0) {
        try {
          const parsedHost = new URL(canonicalUrl).hostname;
          if (parsedHost && parsedHost !== activeHost) {
            activeHost = parsedHost;
          }
        } catch (_) {}
      }

      if (!canonicalUrl || seenIds.has(postId) || seenUrls.has(canonicalUrl)) {
        continue;
      }

      // Filter by author byline on multi-author publications (e.g. www.thefp.com, www.public.news)
      if (!matchesTargetAuthor(post, explicitAuthorName)) {
        continue;
      }

      const rawTitle = (post.title || 'Untitled').trim();
      const audience = post.audience || 'everyone';

      // 1. Skip paywalled posts by default
      if (!includePaid && audience === 'only_paid') {
        skippedPaidForAuthor++;
        continue;
      }

      // 2. Skip "(Audio)" or podcast/video-only editions by default
      if (
        !includeAudio &&
        (post.type === 'podcast' ||
          /^\s*\(audio\)/i.test(rawTitle) ||
          /\/audio-?/i.test(canonicalUrl))
      ) {
        continue;
      }

      const wordCount = Number(post.wordcount) || 0;
      if (minWordCount > 0 && wordCount > 0 && wordCount < minWordCount) {
        continue;
      }

      let charLength = 0;
      if (verifyCharLength) {
        charLength = await probeArticleCharLength(canonicalUrl);
      }

      const baseTitleClean = rawTitle
        .replace(/^\s*\(audio\)\s*/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');

      if (/^\s*\(audio\)/i.test(rawTitle) && seenNormalizedTitles.has(baseTitleClean)) {
        continue;
      }

      const lengthFingerprint = `${baseTitleClean}:${wordCount || charLength}`;
      if (seenTitleAndLength.has(lengthFingerprint)) {
        continue;
      }

      seenIds.add(postId);
      seenUrls.add(canonicalUrl);
      seenNormalizedTitles.add(baseTitleClean);
      seenTitleAndLength.add(lengthFingerprint);

      const bylineNames = (post.publishedBylines || []).map(b => b.name).filter(Boolean);
      const authorFromPost =
        bylineNames.join(', ') || explicitAuthorName || activeHost.split('.')[0];

      collected.push({
        id: postId,
        title: rawTitle,
        subtitle: (post.subtitle || '').trim(),
        url: canonicalUrl,
        date: (post.post_date || new Date().toISOString()).slice(0, 10),
        wordCount,
        charLength,
        audience,
        authorName: authorFromPost
      });
    }

    offset += posts.length;
  }

  if (skippedPaidForAuthor > 0) {
    console.log(
      `ℹ️ Skipped ${skippedPaidForAuthor} paywalled ('only_paid') post(s) by ${
        explicitAuthorName || 'this author'
      } (pass --include-paid to include them).`
    );
  }

  return collected;
}

async function main() {
  const targetInput = positional.join(' ').trim();
  if (!targetInput && !explicitAuthorName) {
    console.log(`Usage:
  bun fetch-substack-urls.js www.thefp.com --author="Bari Weiss" --overwrite
  bun fetch-substack-urls.js www.thefp.com --author="Nellie Bowles" --overwrite
  bun fetch-substack-urls.js helenpluckrose --author="Helen Pluckrose" --overwrite

Options:
  --author="Name"   Filter multi-author publications by byline & set output slug
  --search="Term"   Optional Substack server-side archive search filter (e.g. --search="TGIF")
  --any-author      Disable strict byline filtering even when --author is set
  --limit=N         Number of recent public columns to fetch (default: ${DEFAULT_LIMIT})
  --min-words=N     Skip short notes/teasers under N words (default: ${DEFAULT_MIN_WORDS})
  --include-paid    Include paywalled ('only_paid') posts (skipped by default)
  --include-audio   Include '(Audio)' or podcast posts (skipped by default)
  --probe-chars     Fetch each page to log exact extracted HTML character length
  --overwrite       Replace the output file instead of appending`);
    process.exit(1);
  }

  const host = resolveSubstackHost(targetInput || explicitAuthorName);
  console.log(
    `\n📡 Querying Substack archive API at: https://${host}/api/v1/archive${
      explicitAuthorName ? ` [Byline Filter: "${explicitAuthorName}"]` : ''
    }${searchFilter ? ` [Search: "${searchFilter}"]` : ''}...`
  );

  const posts = await fetchSubstackArchive(host, limit, minWords);
  if (posts.length === 0) {
    console.log(`⚠️ No public posts found on ${host} matching criteria.`);
    process.exit(0);
  }

  const resolvedAuthor = explicitAuthorName || posts[0].authorName || host;
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
        .forEach(u => existingUrls.add(u));
    } catch (_) {}
  }

  const newPosts = posts.filter(p => !existingUrls.has(p.url));
  if (newPosts.length === 0) {
    console.log(
      `ℹ️ Fetched ${posts.length} recent column(s) from ${host}, but all are already in ${path.basename(outputFilePath)} (use --overwrite to replace).`
    );
    process.exit(0);
  }

  const linesToWrite = [];
  if (!existingContent || overwriteFile) {
    linesToWrite.push(
      `# Substack Training URLs for ${resolvedAuthor} (${new Date().toISOString().slice(0, 10)})`,
      `# Source Archive: https://${host}/archive (min-words: ${minWords}, public-only: ${!includePaid})`,
      `# Delete or '#' comment out any unsuitable URL lines before running grow-verse-profile.js`,
      ``
    );
  } else {
    linesToWrite.push(
      ``,
      `# Appended Substack slice (${new Date().toISOString().slice(0, 10)})`
    );
  }

  console.log(`\n🔎 Retrieved ${newPosts.length} unique column(s) for ${resolvedAuthor}:\n`);

  newPosts.forEach((p, idx) => {
    const subLabel = p.subtitle ? ` — ${p.subtitle}` : '';
    const metrics = [
      `id:${p.id}`,
      `by:${p.authorName}`,
      p.wordCount ? `${p.wordCount}w` : null,
      p.charLength ? `${p.charLength} chars` : null,
      p.audience !== 'everyone' ? p.audience : 'public'
    ]
      .filter(Boolean)
      .join(', ');

    console.log(
      `  ${idx + 1}. [${p.date}] ${p.title}${subLabel} (${metrics})\n     ${p.url}`
    );

    linesToWrite.push(`# [${p.date}] ${p.title}${subLabel} (${metrics})`);
    linesToWrite.push(p.url);
  });

  const payload = linesToWrite.join('\n') + '\n';
  if (overwriteFile) {
    await fs.writeFile(outputFilePath, payload, 'utf8');
  } else {
    await fs.appendFile(outputFilePath, payload, 'utf8');
  }

  console.log(`\n======================================================================`);
  console.log(`✅ ${overwriteFile ? 'Wrote' : 'Appended'} ${newPosts.length} canonical Substack URL(s) to: ${outputFilePath}`);
  console.log(`👉 Train profile with:`);
  console.log(`   bun grow-verse-profile.js --author="${resolvedAuthor}" --urls-file=${path.basename(outputFilePath)}`);
  console.log(`======================================================================\n`);
}

main().catch(err => {
  console.error('Fatal error in fetch-substack-urls:', err.message);
  process.exit(1);
});
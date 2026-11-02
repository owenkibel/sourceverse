import fs from 'fs/promises';
import path from 'path';

const BOOKMARKS_PATH = '/home/owen/.config/google-chrome-unstable/Default/Bookmarks';
const DEFAULT_LIMIT = 10;

function chromeDateToJsDate(chromeDateStr) {
  const microseconds = BigInt(chromeDateStr || '0');
  const milliseconds = microseconds / 1000n;
  const epochDifference = 11644473600000n;
  return new Date(Number(milliseconds - epochDifference));
}

function collectBookmarks(node, allBookmarks, folderChain = '') {
  const currentFolder = node.name
    ? folderChain
      ? `${folderChain}/${node.name}`
      : node.name
    : folderChain;

  if (node.url) {
    allBookmarks.push({
      name: node.name || '(Untitled)',
      url: cleanAndUnwrapUrl(node.url),
      date_added: node.date_added,
      folder: currentFolder
    });
  }
  if (node.children) {
    for (const child of node.children) {
      collectBookmarks(child, allBookmarks, currentFolder);
    }
  }
}

function cleanAndUnwrapUrl(u) {
  if (!u) return '';
  let cleaned = u.trim();

  // 1. Unwrap Google AMP CDN cache URLs (https://*-cdn.ampproject.org/v/s/... or /c/s/...)
  cleaned = cleaned.replace(
    /^https?:\/\/[^/]+\.cdn\.ampproject\.org\/[vc]\/(s\/)?/i,
    (_, isHttps) => (isHttps ? 'https://' : 'http://')
  );

  // 2. Strip trailing .amp or /amp and AMP query/hash parameters
  cleaned = cleaned
    .replace(/\.amp(\?.*|#.*)?$/i, '')
    .replace(/\/amp\/?(\?.*|#.*)?$/i, '');

  // 3. Strip tracking query strings on non-YouTube URLs
  try {
    const parsed = new URL(cleaned);
    if (
      (parsed.hostname.includes('youtube.com') || parsed.hostname.includes('youtu.be')) &&
      parsed.searchParams.has('v')
    ) {
      return `https://${parsed.hostname}/watch?v=${parsed.searchParams.get('v')}`;
    }
    return (parsed.origin + parsed.pathname).replace(/\/$/, '');
  } catch {
    return cleaned.split(/[?#]/)[0].replace(/\/$/, '');
  }
}

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
let customOutFile = null;
let explicitAuthorName = null;
let bareUrlsOnly = false;
let overwriteFile = false;
const queryTokens = [];

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg.startsWith('--limit=')) {
    limit = parseInt(arg.split('=')[1], 10) || DEFAULT_LIMIT;
  } else if (arg === '--limit' && rawArgs[i + 1]) {
    limit = parseInt(rawArgs[++i], 10) || DEFAULT_LIMIT;
  } else if (arg.startsWith('--out=')) {
    customOutFile = arg.split('=').slice(1).join('=').trim();
  } else if (arg.startsWith('--author=')) {
    explicitAuthorName = arg.split('=').slice(1).join('=').trim();
  } else if (arg === '--raw' || arg === '--no-comments') {
    bareUrlsOnly = true;
  } else if (arg === '--overwrite' || arg === '--replace') {
    overwriteFile = true;
  } else if (!arg.startsWith('--')) {
    // Allow space-separated tokens or negative tokens like -x.com
    arg.split(/\s+/).filter(Boolean).forEach(t => queryTokens.push(t));
  }
}

async function main() {
  if (queryTokens.length === 0 && !explicitAuthorName) {
    console.log(`Usage (Chrome-style Logical AND search):
  bun extract-author-urls.js turley fox --overwrite
  bun extract-author-urls.js jonathan turley -x.com --overwrite
  bun extract-author-urls.js "Jonathan Turley" --limit=12

Options:
  -term           Exclude any bookmark matching 'term' (e.g., -x.com)
  --overwrite     Replace the output file instead of appending
  --author="Name" Explicit author label/filename slug (default: derived from query)
  --out=FILE      Custom output filename (default: <slug>-urls.txt)
  --limit=N       Max recent bookmarks to slice (default: ${DEFAULT_LIMIT})
  --raw           Write bare URLs only (omit '# [Date] Title' comments)`);
    process.exit(1);
  }

  // If user only passed --author="Jonathan Turley", use those words as search tokens
  const activeTokens =
    queryTokens.length > 0
      ? queryTokens
      : explicitAuthorName.split(/\s+/).filter(Boolean);

  const mustMatchTokens = activeTokens
    .filter(t => !t.startsWith('-'))
    .map(t => t.toLowerCase());

  const mustExcludeTokens = activeTokens
    .filter(t => t.startsWith('-') && t.length > 1)
    .map(t => t.slice(1).toLowerCase());

  const displayLabel = explicitAuthorName || mustMatchTokens.join(' ');
  const fileSlug = slugify(explicitAuthorName || mustMatchTokens.join('-'));
  const outputFilePath = path.resolve(
    process.cwd(),
    customOutFile || `${fileSlug}-urls.txt`
  );

  // Read & sort Chrome Bookmarks (newest first)
  const rawData = await fs.readFile(BOOKMARKS_PATH, 'utf8');
  const bookmarksJson = JSON.parse(rawData);
  const allBookmarks = [];

  for (const key of Object.keys(bookmarksJson.roots)) {
    collectBookmarks(bookmarksJson.roots[key], allBookmarks);
  }

  const sortedBookmarks = allBookmarks
    .map(bm => ({ ...bm, date: chromeDateToJsDate(bm.date_added) }))
    .sort((a, b) => b.date - a.date);

  // Chrome Bookmark Organizer logic: ALL positive tokens must match, NO negative tokens may match
  const seenNormalizedUrls = new Set();
  const matchedBookmarks = [];

  for (const bm of sortedBookmarks) {
    if (!bm.url || !bm.url.startsWith('http')) continue;

    const haystack = `${bm.name} ${bm.url} ${bm.folder}`.toLowerCase();

    const allPositiveMatch = mustMatchTokens.every(term => haystack.includes(term));
    if (!allPositiveMatch) continue;

    const anyNegativeMatch = mustExcludeTokens.some(term => haystack.includes(term));
    if (anyNegativeMatch) continue;

    const norm = cleanAndUnwrapUrl(bm.url);
    if (seenNormalizedUrls.has(norm)) continue;
    seenNormalizedUrls.add(norm);

    matchedBookmarks.push(bm);
    if (matchedBookmarks.length >= limit) break;
  }

  if (matchedBookmarks.length === 0) {
    console.log(
      `⚠️ No bookmarks matched ALL terms [${mustMatchTokens.join(' AND ')}]${
        mustExcludeTokens.length ? ` excluding [${mustExcludeTokens.join(', ')}]` : ''
      }.`
    );
    process.exit(0);
  }

  let existingContent = '';
  const existingNormalized = new Set();

  if (!overwriteFile) {
    try {
      existingContent = await fs.readFile(outputFilePath, 'utf8');
      existingContent
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'))
        .forEach(u => existingNormalized.add(cleanAndUnwrapUrl(u)));
    } catch (_) {}
  }

  const newItems = matchedBookmarks.filter(
    bm => !existingNormalized.has(cleanAndUnwrapUrl(bm.url))
  );

  if (newItems.length === 0) {
    console.log(
      `ℹ️ Matched ${matchedBookmarks.length} bookmark(s), but all are already in ${path.basename(outputFilePath)} (use --overwrite to replace).`
    );
    process.exit(0);
  }

  const linesToWrite = [];
  const filterDesc = `MUST MATCH: [${mustMatchTokens.join(' + ')}]${
    mustExcludeTokens.length ? ` | EXCLUDE: [${mustExcludeTokens.join(', ')}]` : ''
  }`;

  if (!existingContent || overwriteFile) {
    linesToWrite.push(
      `# Training URLs for ${displayLabel} (${new Date().toISOString().slice(0, 10)})`,
      `# Filter: ${filterDesc}`,
      `# Delete or '#' comment out any unsuitable URL lines before running grow-verse-profile.js`,
      ``
    );
  } else {
    linesToWrite.push(
      ``,
      `# Appended slice (${new Date().toISOString().slice(0, 10)}) — ${filterDesc}`
    );
  }

  console.log(`\n🔎 Matched ${matchedBookmarks.length} recent bookmark(s) (${filterDesc}):\n`);

  newItems.forEach((bm, idx) => {
    const dateStr = bm.date.toISOString().slice(0, 10);
    const cleanTitle = bm.name.replace(/\s+/g, ' ').trim();
    console.log(`  ${idx + 1}. [${dateStr}] ${cleanTitle}\n     ${bm.url}`);

    if (!bareUrlsOnly) {
      linesToWrite.push(`# [${dateStr}] ${cleanTitle}`);
    }
    linesToWrite.push(bm.url);
  });

  const payload = linesToWrite.join('\n') + '\n';
  if (overwriteFile) {
    await fs.writeFile(outputFilePath, payload, 'utf8');
  } else {
    await fs.appendFile(outputFilePath, payload, 'utf8');
  }

  console.log(`\n======================================================================`);
  console.log(`✅ ${overwriteFile ? 'Wrote' : 'Appended'} ${newItems.length} URL(s) to: ${outputFilePath}`);
  console.log(`👉 Train profile with:`);
  console.log(`   bun grow-verse-profile.js --author="${explicitAuthorName || 'Jonathan Turley'}" --urls-file=${path.basename(outputFilePath)}`);
  console.log(`======================================================================\n`);
}

main().catch(err => {
  console.error('Fatal error in extract-author-urls:', err);
  process.exit(1);
});
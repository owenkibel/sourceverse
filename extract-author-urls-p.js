import fs from 'fs/promises';
import path from 'path';

const BOOKMARKS_PATH = '/home/owen/.config/google-chrome-unstable/Default/Bookmarks';
const DEFAULT_LIMIT = 10;

// --- Utilities (Matched to generate-links8.js) ---

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
      url: node.url,
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

function normalizeUrl(u) {
  try {
    const parsed = new URL(u);
    if (
      (parsed.hostname.includes('youtube.com') || parsed.hostname.includes('youtu.be')) &&
      parsed.searchParams.has('v')
    ) {
      return `${parsed.hostname}/watch?v=${parsed.searchParams.get('v')}`;
    }
    return (parsed.origin + parsed.pathname).replace(/\/$/, '');
  } catch {
    return u.split('?')[0].replace(/\/$/, '');
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
// Supports:
//   bun extract-author-urls.js "Jonathan Turley"
//   bun extract-author-urls.js Jonathan Turley
//   bun extract-author-urls.js --author="Jonathan Turley" [--limit=12] [--out=black101-urls.txt]
const rawArgs = process.argv.slice(2);

let limit = DEFAULT_LIMIT;
let customOutFile = null;
let extraAliases = [];
let bareUrlsOnly = false;
const positionalWords = [];

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg.startsWith('--limit=')) {
    limit = parseInt(arg.split('=')[1], 10) || DEFAULT_LIMIT;
  } else if (arg === '--limit' && rawArgs[i + 1]) {
    limit = parseInt(rawArgs[++i], 10) || DEFAULT_LIMIT;
  } else if (arg.startsWith('--out=')) {
    customOutFile = arg.split('=').slice(1).join('=').trim();
  } else if (arg.startsWith('--alias=')) {
    extraAliases = arg
      .split('=')
      .slice(1)
      .join('=')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
  } else if (arg.startsWith('--author=')) {
    positionalWords.push(arg.split('=').slice(1).join('=').trim());
  } else if (arg === '--author' && rawArgs[i + 1]) {
    positionalWords.push(rawArgs[++i].trim());
  } else if (arg === '--raw' || arg === '--no-comments') {
    bareUrlsOnly = true;
  } else if (!arg.startsWith('--')) {
    positionalWords.push(arg);
  }
}

const authorQuery = positionalWords.join(' ').trim();

async function main() {
  if (!authorQuery) {
    console.log(`Usage:
  bun extract-author-urls.js "Jonathan Turley"
  bun extract-author-urls.js Jonathan Turley --limit=15
  bun extract-author-urls.js --author="Black 101" --alias="conrad black,conradmblack" --out=black101-urls.txt

Options:
  --limit=N       Number of most recent matching bookmarks to slice (default: ${DEFAULT_LIMIT})
  --out=FILE      Output filename (default: <author-slug>-urls.txt)
  --alias=a,b     Additional case-insensitive handles or domain terms to match
  --raw           Write bare URLs only (omit '# [Date] Title' comment lines)`);
    process.exit(1);
  }

  const authorSlug = slugify(authorQuery);
  const outputFilePath = path.resolve(
    process.cwd(),
    customOutFile || `${authorSlug}-urls.txt`
  );

  // Build case-insensitive search variants:
  // e.g. "Jonathan Turley" -> ["jonathan turley", "jonathanturley", "jonathan-turley"]
  const lowerAuthor = authorQuery.toLowerCase();
  const compactAuthor = lowerAuthor.replace(/[^a-z0-9]/g, '');
  const hyphenAuthor = slugify(authorQuery);

  const searchTerms = [
    ...new Set([lowerAuthor, compactAuthor, hyphenAuthor, ...extraAliases].filter(Boolean))
  ];

  // Read Chrome Bookmarks
  const rawData = await fs.readFile(BOOKMARKS_PATH, 'utf8');
  const bookmarksJson = JSON.parse(rawData);
  const allBookmarks = [];

  for (const key of Object.keys(bookmarksJson.roots)) {
    collectBookmarks(bookmarksJson.roots[key], allBookmarks);
  }

  // Sort newest first
  const sortedBookmarks = allBookmarks
    .map(bm => ({ ...bm, date: chromeDateToJsDate(bm.date_added) }))
    .sort((a, b) => b.date - a.date);

  // Filter case-insensitively across title, URL, and bookmark folder
  const seenNormalizedUrls = new Set();
  const matchedBookmarks = [];

  for (const bm of sortedBookmarks) {
    if (!bm.url || !bm.url.startsWith('http')) continue;

    const haystack = `${bm.name} ${bm.url} ${bm.folder}`.toLowerCase();
    const isMatch = searchTerms.some(term => haystack.includes(term));
    if (!isMatch) continue;

    const norm = normalizeUrl(bm.url);
    if (seenNormalizedUrls.has(norm)) continue;
    seenNormalizedUrls.add(norm);

    matchedBookmarks.push(bm);
    if (matchedBookmarks.length >= limit) break;
  }

  if (matchedBookmarks.length === 0) {
    console.log(`⚠️ No bookmarks found matching "${authorQuery}" (searched terms: ${searchTerms.join(', ')}).`);
    process.exit(0);
  }

  // Check existing file so we only append URLs not already present
  let existingContent = '';
  const existingNormalized = new Set();
  try {
    existingContent = await fs.readFile(outputFilePath, 'utf8');
    existingContent
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .forEach(u => existingNormalized.add(normalizeUrl(u)));
  } catch (_) {}

  const newItems = matchedBookmarks.filter(
    bm => !existingNormalized.has(normalizeUrl(bm.url))
  );

  if (newItems.length === 0) {
    console.log(
      `ℹ️ Found ${matchedBookmarks.length} recent bookmark(s) for "${authorQuery}", but all of them are already in ${path.basename(outputFilePath)}.`
    );
    process.exit(0);
  }

  const linesToAppend = [];
  if (!existingContent) {
    linesToAppend.push(
      `# Training URLs for ${authorQuery} (Generated ${new Date().toISOString().slice(0, 10)})`,
      `# Delete any unsuitable URL lines below before running grow-verse-profile.js`,
      ``
    );
  } else {
    linesToAppend.push(
      ``,
      `# Appended slice (${new Date().toISOString().slice(0, 10)})`
    );
  }

  console.log(`\n🔎 Matched ${matchedBookmarks.length} recent bookmark(s) for "${authorQuery}" (appending ${newItems.length} new):\n`);

  newItems.forEach((bm, idx) => {
    const dateStr = bm.date.toISOString().slice(0, 10);
    const cleanTitle = bm.name.replace(/\s+/g, ' ').trim();
    console.log(`  ${idx + 1}. [${dateStr}] ${cleanTitle}\n     ${bm.url}`);

    if (!bareUrlsOnly) {
      linesToAppend.push(`# [${dateStr}] ${cleanTitle}`);
    }
    linesToAppend.push(bm.url);
  });

  const payload = linesToAppend.join('\n') + '\n';
  await fs.appendFile(outputFilePath, payload, 'utf8');

  console.log(`\n======================================================================`);
  console.log(`✅ Appended ${newItems.length} URL(s) to: ${outputFilePath}`);
  console.log(`👉 Review/weed out links, then train with:`);
  console.log(`   bun grow-verse-profile.js --author="${authorQuery}" --urls-file=${path.basename(outputFilePath)}`);
  console.log(`======================================================================\n`);
}

main().catch(err => {
  console.error('Fatal error in extract-author-urls:', err);
  process.exit(1);
});
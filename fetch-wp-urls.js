import fs from 'fs/promises';
import path from 'path';
import { convert } from 'html-to-text';

const DEFAULT_LIMIT = 10;

const slugify = (t) =>
  (t || 'author')
    .toString()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/^-+|-+$/g, '');

const rawArgs = process.argv.slice(2);
let limit = DEFAULT_LIMIT;
let explicitAuthorName = 'Joel Kotkin';
let overwriteFile = false;
let followSyndicated = false;
let siteInput = 'https://joelkotkin.com';

for (const arg of rawArgs) {
  if (arg.startsWith('--limit=')) limit = parseInt(arg.split('=')[1], 10) || DEFAULT_LIMIT;
  else if (arg.startsWith('--author=')) explicitAuthorName = arg.split('=').slice(1).join('=').trim();
  else if (arg === '--overwrite' || arg === '--replace') overwriteFile = true;
  else if (arg === '--follow-syndicated') followSyndicated = true;
  else if (!arg.startsWith('--')) siteInput = arg;
}

async function main() {
  const baseUrl = siteInput.startsWith('http') ? siteInput.replace(/\/$/, '') : `https://${siteInput.replace(/\/$/, '')}`;
  const apiUrl = `${baseUrl}/wp-json/wp/v2/posts?per_page=${Math.min(limit * 2, 30)}&_t=${Date.now()}`;

  console.log(`\n📡 Querying WordPress REST API at: ${apiUrl} ...`);
  const res = await fetch(apiUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 Sourceverse-WP-Fetcher', 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000)
  });

  if (!res.ok) throw new Error(`WordPress API returned HTTP ${res.status}`);
  const posts = await res.json();

  const collected = [];
  for (const post of posts) {
    if (collected.length >= limit) break;

    const rawTitle = convert(post.title?.rendered || 'Untitled', { wordwrap: false }).trim();
    const contentHtml = post.content?.rendered || '';
    const plainText = convert(contentHtml, { wordwrap: false }).replace(/\s+/g, ' ').trim();
    const wordCount = plainText ? plainText.split(/\s+/).length : 0;

    // Detect syndicated link ("Read the rest of this piece at ...")
    const syndMatch = contentHtml.match(/<a[^>]+href=["']([^"']+)["'][^>]*>\s*Read the rest of this piece[^<]*<\/a>/i);
    const syndicatedUrl = syndMatch ? syndMatch[1] : null;

    const finalUrl = followSyndicated && syndicatedUrl ? syndicatedUrl : post.link;
    collected.push({
      id: post.id,
      date: (post.date || '').slice(0, 10),
      title: rawTitle,
      url: finalUrl,
      wordCount,
      isExcerpt: Boolean(syndicatedUrl && wordCount < 450)
    });
  }

  const fileSlug = slugify(explicitAuthorName);
  const outputFilePath = path.resolve(process.cwd(), `${fileSlug}-urls.txt`);

  const lines = [
    `# WordPress Training URLs for ${explicitAuthorName} (${new Date().toISOString().slice(0, 10)})`,
    `# Source: ${baseUrl}/wp-json/wp/v2/posts`,
    ``
  ];

  console.log(`\n🔎 Retrieved ${collected.length} recent article(s) for ${explicitAuthorName}:\n`);
  collected.forEach((p, idx) => {
    const note = p.isExcerpt ? `${p.wordCount}w excerpt on WP` : `${p.wordCount}w`;
    console.log(`  ${idx + 1}. [${p.date}] ${p.title} (id:${p.id}, ${note})\n     ${p.url}`);
    lines.push(`# [${p.date}] ${p.title} (id:${p.id}, ${note})`);
    lines.push(p.url);
  });

  await fs.writeFile(outputFilePath, lines.join('\n') + '\n', 'utf8');
  console.log(`\n✅ Wrote ${collected.length} URL(s) to: ${outputFilePath}\n`);
}

main().catch(err => {
  console.error('Fatal error in fetch-wp-urls:', err.message);
  process.exit(1);
});
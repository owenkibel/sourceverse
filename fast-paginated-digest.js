#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Operational Configurations
const PAGE_SIZE = 50;
const FETCH_TIMEOUT_MS = 3000; 
const TIMESTAMP_FILE = 'last-bookmark-timestamp.txt';
const TARGET_DIR = path.join(process.cwd(), 'posts');

const PROBLEMATIC_DOMAINS = [
  'x.com', 'twitter.com', 't.co', 'instagram.com', 'facebook.com', 'linkedin.com', 'reddit.com', 'washingtonpost.com',
  'nytimes.com',
  'wsj.com',
  'ft.com',
  'theatlantic.com',
  'newyorker.com',
  'bloomberg.com',
  'economist.com'
];

function findBookmarksPath() {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return './Bookmarks';
  
  if (process.platform === 'win32') {
    return path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Bookmarks');
  } else if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Bookmarks');
  } else {
    const possiblePaths = [
      path.join(home, '.config', 'google-chrome-unstable', 'Default', 'Bookmarks'),
      path.join(home, '.config', 'cachyos-browser', 'Default', 'Bookmarks'),
      path.join(home, '.config', 'google-chrome', 'Default', 'Bookmarks'),
      path.join(home, '.config', 'chromium', 'Default', 'Bookmarks')
    ];
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) return p;
    }
    return './Bookmarks';
  }
}

function formatHumanDate(ts) {
  if (!ts) return null;
  try {
    let ms = ts;
    if (ts > 1e13) {
      ms = (ts / 1000) - 11644473600000;
    }
    return new Date(ms).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  } catch {
    return null;
  }
}

/**
 * Normalizes external scraped date strings (ISO, UTC, etc.) into clean display markers
 */
function formatArticleDate(dateStr) {
  if (!dateStr) return null;
  try {
    const parsed = new Date(dateStr);
    if (isNaN(parsed.getTime())) return dateStr; // Fall back to raw string if formatting engine struggles
    return parsed.toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric'
    });
  } catch {
    return dateStr;
  }
}

function extractBookmarksRecursively(folder) {
  let items = [];
  if (!folder || !folder.children) return items;
  for (const child of folder.children) {
    if (child.type === 'url') {
      items.push({
        title: child.name,
        url: child.url,
        dateAdded: parseInt(child.date_added, 10) || 0
      });
    } else if (child.type === 'folder') {
      items.push(...extractBookmarksRecursively(child));
    }
  }
  return items;
}

function checkProblematicDomain(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    return PROBLEMATIC_DOMAINS.some(domain => host === domain || host.endsWith('.' + domain));
  } catch {
    return true;
  }
}

/**
 * Enhanced High-Speed Regular Expression Metadata Scanner
 */
function parseMetadata(html) {
  let title = '';
  let description = 'No summary details compiled.';
  let image = '';
  let publishedTime = '';
  let siteName = '';
  let author = '';

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch && titleMatch[1]) title = titleMatch[1].trim();

  // 1. Description Lookup Matrix
  const descMatch = html.match(/<meta[^>]+(?:name|property)=["'](?:og:)?description["'][^>]+content=["']([^"']*)["']/i) ||
                    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["'](?:og:)?description["']/i);
  if (descMatch && descMatch[1]) description = descMatch[1].trim();

  // 2. Image Asset Allocation
  const imgMatch = html.match(/<meta[^>]+(?:name|property)=["']og:image["'][^>]+content=["']([^"']*)["']/i) ||
                   html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']og:image["']/i);
  if (imgMatch && imgMatch[1]) image = imgMatch[1].trim();

  // 3. Article Publication Dateline Target Selection
  const dateMatch = html.match(/<meta[^>]+(?:name|property)=["'](?:article:published_time|og:article:published_time|published_time|pubdate)["'][^>]+content=["']([^"']*)["']/i) ||
                    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["'](?:article:published_time|og:article:published_time|published_time|pubdate)["']/i);
  if (dateMatch && dateMatch[1]) publishedTime = dateMatch[1].trim();

  // 4. Source Platform Extraction (og:site_name)
  const siteMatch = html.match(/<meta[^>]+(?:name|property)=["']og:site_name["'][^>]+content=["']([^"']*)["']/i) ||
                    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']og:site_name["']/i);
  if (siteMatch && siteMatch[1]) siteName = siteMatch[1].trim();

  // 5. Author/Creator Attribution Tracking
  const authorMatch = html.match(/<meta[^>]+(?:name|property)=["'](?:author|article:author)["'][^>]+content=["']([^"']*)["']/i) ||
                      html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["'](?:author|article:author)["']/i);
  if (authorMatch && authorMatch[1]) author = authorMatch[1].trim();

  return { title, description, image, publishedTime, siteName, author };
}

async function fastScrape(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' }
    });
    clearTimeout(timeoutId);
    if (!response.ok) return null;
    const text = await response.text();
    return parseMetadata(text);
  } catch {
    clearTimeout(timeoutId);
    return null;
  }
}

async function main() {
  let lastSavedTimestamp = 0;
  const isFirstRun = !fs.existsSync(TIMESTAMP_FILE);
  if (!isFirstRun) {
    lastSavedTimestamp = parseInt(fs.readFileSync(TIMESTAMP_FILE, 'utf-8').trim(), 10) || 0;
  }

  const bookmarksSrc = findBookmarksPath();
  console.log(`📖 Target database resolved at: ${bookmarksSrc}`);
  
  if (!fs.existsSync(bookmarksSrc)) {
    console.error(`❌ Source Bookmarks file missing.`);
    process.exit(1);
  }

  const rawData = JSON.parse(fs.readFileSync(bookmarksSrc, 'utf-8'));
  const targetRoot = rawData.roots?.other;
  if (!targetRoot) {
    console.error("❌ Isolation Error: 'Other' bookmark node missing.");
    process.exit(1);
  }

  let bookmarksPool = extractBookmarksRecursively(targetRoot);
  bookmarksPool.sort((a, b) => b.dateAdded - a.dateAdded);

  if (bookmarksPool.length === 0) {
    console.log('💤 "Other" bookmarks folder is empty.');
    process.exit(0);
  }

  const absoluteNewestTimestamp = bookmarksPool[0].dateAdded;
  let toProcess = [];

  if (isFirstRun) {
    console.log(`🚀 First Run Baseline Anchor: Sampling latest ${PAGE_SIZE} elements.`);
    toProcess = bookmarksPool.slice(0, PAGE_SIZE);
  } else {
    toProcess = bookmarksPool.filter(item => item.dateAdded > lastSavedTimestamp);
    if (toProcess.length === 0) {
      console.log('💤 No new folder changes detected.');
      process.exit(0);
    }
    console.log(`✨ Sync payload identified. Queueing up ${toProcess.length} elements for digestion.`);
  }

  if (!fs.existsSync(TARGET_DIR)) {
    fs.mkdirSync(TARGET_DIR, { recursive: true });
  }

  console.log(`⚡ Scanning resource endpoints via lightweight text streams...`);
  const scrapedItems = [];

  for (const entry of toProcess) {
    let title = entry.title || 'Untitled Reference Links';
    let description = 'No summary details compiled.';
    let image = '';
    let publishedTime = '';
    let siteName = '';
    let author = '';

    if (checkProblematicDomain(entry.url)) {
      console.log(`🛑 Blocked Domain (X.com): Local metadata match preserved.`);
    } else {
      const metadata = await fastScrape(entry.url);
      if (metadata) {
        title = metadata.title || title;
        description = metadata.description;
        image = metadata.image;
        publishedTime = metadata.publishedTime;
        siteName = metadata.siteName;
        author = metadata.author;
      }
    }
    
    scrapedItems.push({ 
      title, url: entry.url, description, image, 
      dateAdded: entry.dateAdded, publishedTime, siteName, author 
    });
  }

  console.log(`\n📦 Translating memory queues into markdown documents...`);
  let pageCounter = 1;

  for (let i = 0; i < scrapedItems.length; i += PAGE_SIZE) {
    const chunk = scrapedItems.slice(i, i + PAGE_SIZE);
    const topChunkTimestamp = chunk[0].dateAdded;
    
    let finalIsoTime;
    if (topChunkTimestamp > 1e13) {
      finalIsoTime = new Date((topChunkTimestamp / 1000) - 11644473600000).toISOString();
    } else {
      finalIsoTime = new Date(topChunkTimestamp || Date.now()).toISOString();
    }

    const batchSlugTimestamp = Math.floor(topChunkTimestamp / 1000).toString().slice(-6);
    const postFileName = `bookmarks-digest-p${pageCounter}-${batchSlugTimestamp}.md`;
    const outputMarkdownPath = path.join(TARGET_DIR, postFileName);

  // 1. Capture or fallback to high-precision timestamp for timeline uniformity
    const postDate = finalIsoTime || new Date().toISOString();

    // 2. Safe Frontmatter Generation with JSON.stringify and Content Layer schema alignment
    let markdownBody = `---\n`;
    markdownBody += `title: ${JSON.stringify(`Bookmarks Digest — Page ${pageCounter}`)}\n`;
    markdownBody += `date: "${postDate}"\n`;
    markdownBody += `source: "digest"\n`;
    markdownBody += `description: "Fast compilation update containing ${chunk.length} curated resources."\n`;
    markdownBody += `---\n\n`;

    chunk.forEach((item, idx) => {
      markdownBody += `### ${idx + 1}. [${item.title}](${item.url})\n`;
      
      // Secondary Metadata Context Block
      markdownBody += `<small>\n`;
      markdownBody += `📂 **Saved to Folder:** ${formatHumanDate(item.dateAdded) || 'Unknown'}<br>\n`;
      if (item.publishedTime) {
        markdownBody += `📅 **Original Publication:** ${formatArticleDate(item.publishedTime)}<br>\n`;
      }
      if (item.siteName) {
        markdownBody += `🏛️ **Platform/Host:** ${item.siteName}<br>\n`;
      }
      if (item.author) {
        markdownBody += `✍️ **Author Reference:** ${item.author}<br>\n`;
      }
      markdownBody += `</small>\n\n`;

      if (item.image) markdownBody += `![Preview Image](${item.image})\n\n`;
      markdownBody += `> ${item.description}\n\n`;
      markdownBody += `* [Direct Resource Link](${item.url})\n\n---\n\n`;
    });

    // 3. Collision-Proof File Checking Loop (Utilizing your top-level path import)
    let directory = path.dirname(outputMarkdownPath);
    let ext = path.extname(outputMarkdownPath);
    let baseFilename = path.basename(outputMarkdownPath, ext);

    let counter = 1;
    let finalOutputPath = outputMarkdownPath;

    // Increment filename suffix sequentially if the targeted path is already taken
    while (fs.existsSync(finalOutputPath)) {
      finalOutputPath = path.join(directory, `${baseFilename}-${counter}${ext}`);
      counter++;
    }

    // 4. Secure Write Operation using the unique calculated file path
    fs.writeFileSync(finalOutputPath, markdownBody, 'utf-8');
    console.log(`💾 Saved: ${finalOutputPath} [Contains: ${chunk.length} URLs]`);
    pageCounter++;
  }

  const nextSavedTimestamp = isFirstRun ? absoluteNewestTimestamp : Math.max(...toProcess.map(b => b.dateAdded), 0);
  fs.writeFileSync(TIMESTAMP_FILE, nextSavedTimestamp.toString(), 'utf-8');
  console.log(`\n📝 State Token Synchronized. Baseline set to: ${nextSavedTimestamp}`);
}

main().catch(console.error);
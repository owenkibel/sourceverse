import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import ogs from 'open-graph-scraper';
import { firefox } from 'playwright';

const execAsync = promisify(exec);

// --- Configuration ---
const DEPTH = 40;                    // bookmarks per batch
const MODEL = "grok-4.3";
// const MODEL = "grok-4.20-non-reasoning"

const BOOKMARKS_PATH = '/home/owen/.config/google-chrome-unstable/Default/Bookmarks';
const OUTPUT_DIR = './posts';
const X_OUTPUT_DIR = './x';

// 5000 = best quality/size balance (was 18000). Override any time with: --transcript=8000
const TRANSCRIPT_MAX_CHARS = process.argv.includes('--transcript=')
  ? parseInt(process.argv.find(a => a.startsWith('--transcript='))?.split('=')[1] || '2500')
  : 2500;

const BATCH_SIZE = DEPTH;
const batchArg = process.argv.find(a => a.startsWith('--batch='))?.split('=')[1] || '0';
const batchIndex = parseInt(batchArg, 10) || 0;

const YTDLP_TIMEOUT_MS = 45000;
const TEMP_DIR = os.tmpdir();

// === PROBLEMATIC DOMAINS TO SKIP ENTIRELY (paywalled / slow / unstable) ===
const PROBLEMATIC_DOMAINS = [
  'washingtonpost.com',
  'nytimes.com',
  'wsj.com',
  'ft.com',
  'theatlantic.com',
  'newyorker.com',
  'bloomberg.com',
  'economist.com'
  // Add more domains here as you discover them
];

// --- Utilities ---

function normalizeUrl(u) {
  try {
    const parsed = new URL(u);
    let base = parsed.origin + parsed.pathname;
    return base.replace(/\/$/, '');
  } catch (e) {
    return u.split('?')[0].replace(/\/$/, '');
  }
}

// === FINAL ULTRA-STRICT MATCHER - NO TITLE FALLBACK FOR YOUTUBE ===
function findBestMatchForUrl(url, enrichedData) {
  const normalized = normalizeUrl(url);
  const videoID = getYouTubeVideoID(url);

  // 1. Exact normalized URL (best)
  let match = enrichedData.find(item => normalizeUrl(item.url) === normalized);
  if (match) return match;

  // 2. Exact YouTube video ID (critical - this is what we trust most)
  if (videoID) {
    match = enrichedData.find(item => getYouTubeVideoID(item.url) === videoID);
    if (match) return match;
  }

  // 3. Conservative URL substring only (no title matching for YouTube)
  if (videoID && url.length > 35) {
    match = enrichedData.find(item => 
      item.url.includes(videoID) || url.includes(getYouTubeVideoID(item.url))
    );
    if (match) return match;
  }

  // 4. Absolute last resort ONLY for non-YouTube links
  if (!videoID) {
    const urlSlug = url.split('/').pop().toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 15);
    return enrichedData.find(item => {
      const titleSlug = (item.og_title || item.original_title || '').toLowerCase()
        .replace(/[^a-z0-9]/g, '').substring(0, 15);
      return titleSlug && urlSlug && titleSlug.includes(urlSlug);
    }) || {};
  }

  return {}; // No match for YouTube videos that fail ID check
}

function getYouTubeVideoID(url) {
  const regex = /(?:youtube(?:-nocookie)?\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([^&\n?#]+)/i;
  const match = url.match(regex);
  return match ? match[1] : null;
}

function chromeDateToJsDate(chromeDateStr) {
  if (!chromeDateStr || chromeDateStr === '0') return new Date(0);
  try {
    const microSeconds = BigInt(chromeDateStr);
    const unixMicroSeconds = microSeconds - 116444736000000000n;
    const unixMilliSeconds = Number(unixMicroSeconds / 1000n);
    const date = new Date(unixMilliSeconds);
    if (isNaN(date.getTime())) return new Date(0);
    return date;
  } catch (e) {
    return new Date(0);
  }
}

function collectBookmarks(node, results = []) {
  if (node.type === 'url' && node.url?.startsWith('http')) {
    const title = node.name || '(no title)';
    results.push({
      name: title.length > 80 ? title.substring(0, 77) + '...' : title,
      url: node.url,
      date_added: node.date_added || '0',
    });
  } else if (Array.isArray(node.children)) {
    for (const child of node.children) {
      collectBookmarks(child, results);
    }
  }
  return results;
}

async function fetchWithPlaywright(url, browser, timeout = 30000) {
  // Remove firefox.launch() and browser.close()
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:128.0) Gecko/20100101 Firefox/128.0',
      'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
    ][Math.floor(Math.random() * 3)],
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const page = await context.newPage();

  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      if (url.includes('x.com')) {
        await page.waitForTimeout(10000);  // Keep if needed; consider reducing to 5000–8000
      }

      const data = await page.evaluate(() => {
        let fullText = '';
        let ogTitle = document.querySelector('meta[property="og:title"]')?.content ||
                        document.querySelector('meta[name="twitter:title"]')?.content ||
                        document.title || '';

        // Fixed selector with straight double quotes
        const tweetTexts = Array.from(document.querySelectorAll('[data-testid="tweetText"]'))
          .map(el => el.innerText.trim())
          .filter(t => t);
        const longForm = Array.from(document.querySelectorAll('article div[lang], article div[dir="auto"]'))
          .map(el => el.innerText.trim())
          .filter(t => t);
        fullText = [...new Set([...longForm, ...tweetTexts])].join('\n\n');

        // Trending / explore logic unchanged...
        if (window.location.href.includes('explore') || 
            window.location.href.includes('trending') || 
            window.location.href.includes('/i/trending/')) {
          const trends = Array.from(document.querySelectorAll('[data-testid="trend"], div[dir="auto"][role="heading"] + div[dir="auto"]'))
            .map(el => {
              const heading = el.querySelector('div[dir="auto"][role="heading"]')?.innerText.trim() || '';
              const subtitle = el.querySelector('div[dir="auto"]:not([role="heading"])')?.innerText.trim() || '';
              return heading && subtitle ? `${heading} - ${subtitle}` : (heading || subtitle);
            })
            .filter(t => t)
            .slice(0, 25)
            .join('\n');

          const pageTopic = document.querySelector('h2[role="heading"]')?.innerText || document.title;

          if (trends || pageTopic) {
            fullText = trends 
              ? `Trending on X${pageTopic ? ` – ${pageTopic}` : ''}:\n\n${trends}`
              : fullText;
            ogTitle = pageTopic || 'Trending on X';
          }
        }

        // Article body fallback unchanged...
        if (!fullText || fullText.length < 400) {
          const paragraphs = Array.from(document.querySelectorAll(`
            article p, 
            [role="article"] p, 
            .article-body p, 
            .post-body p, 
            .entry-content p, 
            .story-body p, 
            main p, 
            .prose p, 
            .rich-text p,
            div[dir="auto"] p
          `))
            .map(p => p.innerText.trim())
            .filter(t => t.length > 40)
            .slice(0, 80);
          if (paragraphs.length > 0) {
            fullText = paragraphs.join('\n\n');
          } else {
            fullText = document.querySelector('meta[property="og:description"]')?.content ||
                       document.querySelector('meta[name="twitter:description"]')?.content || 
                       fullText;
          }
        }

        // Image extraction unchanged...
        let images = Array.from(document.querySelectorAll('img[src^="https://pbs.twimg.com/media/"], img[alt*="image"], img[src*="media"]'))
          .map(el => el.src || el.dataset.src || el.getAttribute('src'))
          .filter(src => src && src.includes('pbs.twimg.com') && !src.includes('profile') && !src.includes('emoji'))
          .slice(0, 6);

        if (images.length === 0) {
          images = Array.from(document.querySelectorAll('img[src^="http"]'))
            .map(el => el.src)
            .filter(src => src && src.match(/\.(jpg|jpeg|png|gif|webp)$/i) && 
                   !src.includes('profile') && !src.includes('avatar') && !src.includes('logo') && !src.includes('1x1'))
            .slice(0, 4);
        }

        return {
          ogTitle: ogTitle.trim(),
          ogDescription: fullText.trim(),
          ogImage: images[0] || null,
        };
      });

await context.close();  // Close context, not browser
      return data;
    } catch (error) {
      attempts++;
      console.warn(`Playwright attempt ${attempts}/${maxAttempts} failed for ${url}: ${error.message}`);
      if (attempts >= maxAttempts) {
        await context.close();
        return null;
      }
            await new Promise(resolve => setTimeout(resolve, 4000));
    }
  }
}

async function extractYouTubeTranscript(url) {
  if (url.includes('music.youtube.com')) {
    console.info(`  Skipping transcript extraction for YouTube Music URL: ${url}`);
    return { transcript: '', cacheReused: false };
  }

  const videoID = getYouTubeVideoID(url);
  if (!videoID) {
    console.warn(`  Invalid YouTube URL (no video ID): ${url}`);
    return { transcript: '', cacheReused: false };
  }

  // Unique filename per run
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const vttPath = path.join(TEMP_DIR, `${videoID}-${runId}.en.vtt`);

  // Delete any old/stale VTT files for this videoID
  try {
    const files = await fs.readdir(TEMP_DIR);
    for (const file of files) {
      if (file.startsWith(`${videoID}-`) && file.endsWith('.en.vtt')) {
        await fs.unlink(path.join(TEMP_DIR, file)).catch(() => {});
      }
    }
  } catch (e) {}

  let transcript = '';
  let cacheReused = false;

  try {
    // Try fresh download
    console.log(`  Running yt-dlp for transcript (ID: ${videoID})`);
    await execAsync(`yt-dlp --write-auto-sub --skip-download --sub-lang en --sub-format vtt --no-playlist -o "${TEMP_DIR}/${videoID}-${runId}" "${url}"`, {
      timeout: YTDLP_TIMEOUT_MS,
      stdio: 'ignore'
    });

    transcript = await fs.readFile(vttPath, 'utf8');

  } catch (e) {
    console.warn(`  yt-dlp failed for ${url}: ${e.message || e}`);

    // Fallback: look for any existing cached transcript (safer check)
    try {
      const files = await fs.readdir(TEMP_DIR);
      const cachedFile = files.find(f => f.startsWith(videoID) && f.endsWith('.en.vtt'));
      if (cachedFile) {
        const cachedPath = path.join(TEMP_DIR, cachedFile);
        transcript = await fs.readFile(cachedPath, 'utf8');
        cacheReused = true;
        console.warn(`  ⚠️ Using stale cached transcript for videoID ${videoID}`);
      }
    } catch (e2) {}
  }

  // Always clean up our specific run file (never throw)
  await fs.unlink(vttPath).catch(() => {});

  if (!transcript || !transcript.includes('WEBVTT')) {
    console.info(`  No auto-generated transcript available for ${url}`);
    return { transcript: '', cacheReused: false };
  }

  // === Original cleaning logic (unchanged) ===
  const lines = transcript.split('\n');
  const transcriptLines = [];
  let inCue = false;

  for (let rawLine of lines) {
    let line = rawLine.trim();
    if (!line) continue;

    if (line === 'WEBVTT' || 
        line.startsWith('Kind:') || 
        line.startsWith('Language:') || 
        line.startsWith('Style:') || 
        line.startsWith('NOTE') || 
        line.includes('-->')) {
      inCue = line.includes('-->');
      continue;
    }

    if (inCue || transcriptLines.length > 0) {
      line = line
        .replace(/<[^>]*>/g, '')
        .replace(/&[a-z]+;/gi, ' ')
        .trim();

      if (line) transcriptLines.push(line);
    }
  }

  if (transcriptLines.length === 0) {
    console.info(`  Transcript file exists but no usable text extracted for ${url}`);
    return { transcript: '', cacheReused: false };
  }

  let cleanTranscript = transcriptLines.join(' ').replace(/\s+/g, ' ').trim();

  if (cleanTranscript.length > TRANSCRIPT_MAX_CHARS) {
    cleanTranscript = cleanTranscript.substring(0, TRANSCRIPT_MAX_CHARS) +
      '\n\n[Transcript truncated for length – full video for complete content]';
    console.log(`  Clean transcript extracted and truncated (~${cleanTranscript.length} chars)`);
  } else {
    console.log(`  Clean transcript extracted (~${cleanTranscript.length} chars)`);
  }

  return { transcript: cleanTranscript, cacheReused };
}

async function processGroupToFolder(groupContent, folderName, enrichedData) {
  const folderPath = path.join(X_OUTPUT_DIR, folderName);
  await fs.mkdir(folderPath, { recursive: true });

  const lines = groupContent.split('\n');

  let title = '';
  let poemLines = [];
  let items = [];
  let foundFirstBullet = false;

  if (lines[0]?.startsWith('## ')) {
    title = lines[0].substring(3).trim();
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
      foundFirstBullet = true;
      items.push(line);
    } else if (foundFirstBullet) {
      items[items.length - 1] += '\n' + line;
    } else {
      poemLines.push(line);
    }
  }

  let poem = poemLines.join('\n').trim();

  poem = poem
    .replace(/\*{1,3}([\s\S]*?)\*{1,3}/g, '$1')
    .replace(/_{1,3}([\s\S]*?)_{1,3}/g, '$1')
    .replace(/[ \t]+$/gm, '')
    .trim();

  const mainUrls = [];
  const itemTexts = [];

  for (const item of items) {
    const linkMatch = item.match(/\[\s*([^\[\]]+?)\s*\]\((https?:\/\/[^\)]+)\)/);
    if (!linkMatch) continue;

    const linkTitle = linkMatch[1].trim();
    const url = linkMatch[2].trim();

    let description = '';
    if (item.includes(')**')) {
      description = item.split(')**')[1] || '';
    } else if (item.includes(']:')) {
      description = item.split(']:')[1] || '';
    }
    description = description.replace(/^[:\s]+/, '').trim();

    const cleanText = description || linkTitle;
    if (cleanText) {
      itemTexts.push(cleanText);
      mainUrls.push(url);
    }
  }

  // --- URL Normalizer ---
  const normalizeUrl = (u) => {
    try {
      const parsed = new URL(u);
      let base = parsed.origin + parsed.pathname;
      return base.replace(/\/$/, '');
    } catch (e) {
      return u.split('?')[0].replace(/\/$/, '');
    }
  };

  // --- Build JSON payload + Markdown with reliable thumbnails ---
  const threadPayload = {
    thread_id: folderName,
    title: title || 'Untitled Thread',
    grok_poem: poem || '',
    sources: []
  };

  let plainText = '';
  if (title) plainText += `${title}\n\n`;
  if (poem) plainText += `${poem}\n\n`;

  let markdownBody = '';   // ← this was missing / out of scope before

   for (let i = 0; i < itemTexts.length; i++) {
    const currentUrl = mainUrls[i];
    const sourceData = findBestMatchForUrl(currentUrl, enrichedData);

    // === MATCH DEBUG (remove after confirming fix) ===
    // if (currentUrl.includes('youtube.com')) {
    //   console.log(`   🔍 Thread ${folderName} | URL: ${currentUrl.substring(0, 60)}... → Matched Title: ${sourceData.og_title || 'NO MATCH'}`);
    // }

    // Add to payload for vertical_thread2
    threadPayload.sources.push({
      url: currentUrl,
      description_short: itemTexts[i],
      og_title: sourceData.og_title || itemTexts[i],
      rich_text: sourceData.og_description || null,
      og_image: sourceData.og_image || null
    });

    // Build markdown bullet with reliable thumbnail
    let bullet = `- **[${sourceData.og_title || itemTexts[i]}](${currentUrl})**: ${itemTexts[i]}`;

    if (sourceData.og_image && sourceData.og_image.startsWith('http')) {
      bullet += `\n  ![thumbnail](${sourceData.og_image})`;
    } else {
      bullet += `\n  ![thumbnail](https://via.placeholder.com/400x225/222222/FFFFFF?text=No+Image)`;
    }

    plainText += bullet + '\n\n';
    markdownBody += bullet + '\n\n';
  }

  // Write payload.json
  await fs.writeFile(
    path.join(folderPath, 'payload.json'), 
    JSON.stringify(threadPayload, null, 2) + '\n'
  );

  // Write x-thread.txt
  plainText = plainText.trim();
  await fs.writeFile(path.join(folderPath, 'x-thread.txt'), plainText + '\n');

  // Return the markdown body so main() can use it
  return markdownBody;
}

async function main() {
  try {
    const rawData = await fs.readFile(BOOKMARKS_PATH, 'utf8');
    const bookmarksJson = JSON.parse(rawData);

    const allBookmarks = [];
    for (const key of Object.keys(bookmarksJson.roots)) {
      collectBookmarks(bookmarksJson.roots[key], allBookmarks);
    }

    const sortedBookmarks = allBookmarks
      .map(bm => ({ ...bm, date: chromeDateToJsDate(bm.date_added) }))
      .sort((a, b) => b.date - a.date);

    const withDates = sortedBookmarks.slice(
      batchIndex * BATCH_SIZE,
      (batchIndex + 1) * BATCH_SIZE
    );

    console.log(`Processing batch ${batchIndex} → bookmarks ${batchIndex * BATCH_SIZE + 1}–${(batchIndex + 1) * BATCH_SIZE} (${withDates.length} items)`);

    // console.log(`Processing ${withDates.length} recent bookmarks...`);

    // Launch a single shared Firefox browser for all Playwright fallbacks
    let sharedBrowser = null;
    try {
      sharedBrowser = await firefox.launch({ headless: true });
      console.log('Shared Firefox browser launched for Playwright fallbacks');

       // === HARDENED ENRICHMENT WITH PER-BOOKMARK TIMEOUT ===
      const timeout = (promise, ms, url) => {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Enrichment timeout after ${ms}ms for ${url}`)), ms)
        );
        return Promise.race([promise, timeoutPromise]);
      };

      const enriched = await Promise.all(withDates.map(async (bm, index) => {
        console.log(`\n[${index + 1}/${withDates.length}] Processing: ${bm.name} – ${bm.url}`);

                // === EARLY SKIP FOR KNOWN PROBLEMATIC DOMAINS ===
        const isProblematic = PROBLEMATIC_DOMAINS.some(domain => 
          bm.url.includes(domain)
        );
        if (isProblematic) {
          console.log(`   ⏭️ Skipping known problematic domain: ${bm.url}`);
          return {
            original_title: bm.name,
            url: bm.url,
            added_at: bm.date.toISOString(),
            og_title: bm.name,
            og_description: '[Skipped — known problematic / paywalled domain]',
            og_image: null
          };
        }
        // ================================================

        let ogData = {
          ogTitle: bm.name || '(no title)',
          ogDescription: '',
          ogImage: null,
        };

        try {
                    return await timeout((async () => {
            let ogData = {
              ogTitle: bm.name || '(no title)',
              ogDescription: '',
              ogImage: null,
            };

            let ogsSuccess = false;

            try {
              const { result, html } = await ogs({ url: bm.url, timeout: 12000 });
              
              if (result?.ogTitle) {
                ogData.ogTitle = result.ogTitle || bm.name;
                ogData.ogDescription = result.ogDescription || '';
                ogData.ogImage = Array.isArray(result.ogImage) ? result.ogImage[0]?.url : result.ogImage;
                ogsSuccess = true;

                if (html && !bm.url.includes('youtube.com') && !bm.url.includes('x.com')) {
                  const { convert } = await import('html-to-text');
                  const sanitizeHtml = (await import('sanitize-html')).default;
                  
                  const sanitizedHtml = sanitizeHtml(html, {
                    allowedTags: ['main', 'article', 'p', 'h1', 'h2', 'h3', 'section'] 
                  });
                  const mainText = convert(sanitizedHtml, { wordwrap: false }).replace(/\s+/g, ' ').trim();
                  
                  if (mainText.length > 200) {
                    const articleText = mainText.length > 2500 
                      ? mainText.substring(0, 2500) + '... [Truncated]' 
                      : mainText;
                    ogData.ogDescription += `\n\nFull Article Text:\n${articleText}`;
                    console.log(`  Extracted and appended clean HTML body (~${articleText.length} chars)`);
                  }
                }
              }
            } catch (e) {
              console.warn(`  OGS failed for ${bm.url}: ${e.message}`);
            }

            // YouTube transcript
            let transcriptResult = { transcript: '', cacheReused: false };
            if (bm.url.includes('youtube.com') || bm.url.includes('youtu.be')) {
              transcriptResult = await extractYouTubeTranscript(bm.url);
            }

            let descriptionParts = [];
            if (transcriptResult.transcript) {
              descriptionParts.push(`YouTube Auto-Generated Transcript:\n\n${transcriptResult.transcript}`);
            }
            if (ogsSuccess && ogData.ogDescription?.trim()) {
              const ogsText = ogData.ogDescription.trim();
              const transcriptText = transcriptResult.transcript || '';
              if (ogsText && (!transcriptText || !ogsText.toLowerCase().includes(transcriptText.substring(0, 200).toLowerCase()))) {
                descriptionParts.push(`\n\nOriginal Video Description:\n\n${ogsText}`);
              }
            }
            ogData.ogDescription = descriptionParts.join('') || '';

            // Playwright fallback for hard sites
            if (!transcriptResult.transcript && !ogsSuccess && 
                (bm.url.includes('x.com') || bm.url.includes('newsmax.com') || bm.url.includes('wsj.com') || 
                 bm.url.includes('nytimes.com') || bm.url.includes('ft.com'))) {
              console.log(`  Falling back to Playwright for ${bm.url}`);
              const pwData = await fetchWithPlaywright(bm.url, sharedBrowser);
              if (pwData) {
                ogData.ogTitle = pwData.ogTitle || ogData.ogTitle;
                ogData.ogDescription = pwData.ogDescription || ogData.ogDescription;
                ogData.ogImage = pwData.ogImage || ogData.ogImage;
              }
            }

            // Final return
            return {
              original_title: bm.name,
              url: bm.url,
              added_at: bm.date.toISOString(),
              og_title: ogData.ogTitle,
              og_description: ogData.ogDescription,
              og_image: ogData.ogImage,
              transcript_cache_reused: transcriptResult.cacheReused
            };
          })(), 45000, bm.url);

        } catch (err) {
          console.warn(`   ⚠️ Enrichment timed out or failed for ${bm.url}: ${err.message}`);
          return {
            original_title: bm.name,
            url: bm.url,
            added_at: bm.date.toISOString(),
            og_title: bm.name,
            og_description: '[Enrichment timed out or failed — using minimal data]',
            og_image: null
          };
        }
      }));

      // Truncate transcripts ONLY in the debug section + show cache-reuse warning
      const debugEnriched = enriched.map(item => {
        let desc = item.og_description || '';

        // === CACHE RE-USE WARNING ===
        if (item.transcript_cache_reused === true) {
          desc = `⚠️ [CACHE RE-USE] Transcript was loaded from a previous run (stale cache detected)\n\n` + desc;
          console.warn(`   ⚠️ CACHE RE-USE detected for ${item.url}`);
        }

        return {
          ...item,
          og_description: desc.length > 3200
            ? desc.substring(0, 3200) +
              `\n\n[... ${desc.length - 3200} chars truncated in debug view ...]`
            : desc
        };
      });

      // --- Post-enrichment: Generate blog post via Grok API ---
      const now = new Date();
      const timestamp = now.toISOString();
      const safeTimestamp = timestamp.replace(/[:.]/g, '-');

      const fullPrompt = `You are Grok, an expert curator creating a sophisticated personal blog post from recent bookmarks.

Here are my ${enriched.length} most recent bookmarks (as of ${now.toDateString()}), enriched with Open Graph metadata and (where available) full long-form text from Premium X posts, article bodies, trending topics, threads, and YouTube transcripts:

${JSON.stringify(enriched, null, 2)}

Your task is to produce a high-quality curated post using advanced grouping techniques:
- Employ sophisticated thematic analysis: detect latent connections, narrative arcs, opposing viewpoints, chronological progressions, intersections with current events, and deeper conceptual clusters.
- Create 5–12 meaningful, thematically coherent groups (aim to include as many bookmarks as possible; prefer more focused clusters over very broad ones while avoiding superficial or forced groupings).
- Choose precise, evocative topic names.

For each group:
- Start with "## Topic Name"
- Follow immediately with a classical rhymed and metrical poem (e.g., Shakespearean sonnet, Petrarchan sonnet, limerick sequence, heroic couplets, or similar form) that serves as an engaging, insightful preamble capturing the theme, context, and why it matters now. Present the entire poem in italicized Markdown by wrapping the whole poem block between * and * on their own lines (like a block). NEVER add **bold** around the ## group titles — output them exactly as plain ## Title Name.
- Then list the relevant bookmarks as bullet points:
  - **[og_title](url)**: One sharp, engaging sentence description (hooky, informative, and additive; refine og_description or write your own if better).
  - If og_image is a valid http/https URL, place the following immediately on the next line (no blank line):
    ![thumbnail](og_image)

Any true singletons go in a final "## Miscellaneous" section with the same format.

Output EXACTLY the complete clean markdown body for the blog post (starting with the first ## header; no extra text, no introductions, no closing remarks, no separators).`;

      console.log('Calling Grok API...');
      const response = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'user', content: fullPrompt }],
          temperature: 1,
          // === Force non-reasoning mode on Grok 4.3 ===
  providerOptions: {
    xai: {
      reasoningEffort: "none"
    }
  }
        }),
      });

      //   const response = await fetch('https://api.x.ai/v1/chat/completions', {
      //   method: 'POST',
      //   headers: {
      //     'Content-Type': 'application/json',
      //     'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
      //   },
      //   body: JSON.stringify({
      //     model: MODEL,
      //     messages: [{ role: 'user', content: fullPrompt }],
      //     temperature: 0.7
      //     // providerOptions removed — 4.20-non-reasoning does not use it
      //   }),
      // });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Grok API error: ${response.status} ${errorText}`);
      }

      const apiData = await response.json();
      let markdownBody = apiData.choices[0].message.content.trim();

      markdownBody = markdownBody.replace(/[ \t]+$/gm, '').replace(/\s{2,}\n/g, '\n');

       // === FORCE THUMBNAIL INSERTION + ULTRA-STRICT MATCHING (post-Grok) ===
      markdownBody = markdownBody.replace(
        /-\s*\*?\*?\[([^\]]+?)\]\((https?:\/\/[^\)]+)\)\*?\*?\s*:\s*(.+?)(?=\n\n-\s*\*?\*?\[|\n\n##|\Z)/gs,
        (match, title, url, desc) => {
          const source = findBestMatchForUrl(url, enriched);

          const displayTitle = (source.og_title && source.og_title.length > 8) 
            ? source.og_title 
            : title;

          let bullet = `- **[${displayTitle}](${url})**: ${desc.trim()}`;

          if (source.og_image && source.og_image.startsWith('http')) {
            bullet += `\n  ![thumbnail](${source.og_image})`;
          } else {
            bullet += `\n  ![thumbnail](https://via.placeholder.com/400x225/222222/FFFFFF?text=No+Image)`;
          }
          return bullet + '\n\n';
        }
      );
      
      // === SIMPLIFIED EXTRACTION: include EVERY ## section (including Miscellaneous) ===
      let cleanedBody = markdownBody
        .replace(/\*\*##/g, '##')
        .replace(/##\s+([^\n]+?)\*\*/g, '## $1')
        .replace(/^\*\*## /gm, '## ')
        .replace(/\n{3,}/g, '\n\n');

      const rawGroups = cleanedBody
        .split(/(?=^## )/m)
        .map(g => g.trim())
        .filter(g => g.length > 30);   // keep every real section

      const validGroups = rawGroups.filter(g => g.startsWith('## '));

      console.log(`Raw groups detected: ${rawGroups.length} | All thread folders created: ${validGroups.length}`);

      let debugSection = '\n\n### Debug: Full Input Data Sent to Grok\n\n';
      debugSection += 'This section displays the exact prompt and enriched bookmark data provided to the model (including Playwright-extracted long-form text from Premium X posts, article bodies, trending topics, threads, and YouTube transcripts where available).\n\n';
      debugSection += '```text\n';
      debugSection += fullPrompt.replace(
        JSON.stringify(enriched, null, 2),
        JSON.stringify(debugEnriched, null, 2)
      );
      debugSection += '\n```\n';

 // 1. Generate precision UTC ISO date string for Astro sorting
      const postDate = new Date().toISOString();

      // 2. Updated Frontmatter with JSON.stringify safety, sorting date, and source tag
      const frontMatter = `---
title: ${JSON.stringify(`Links ${timestamp}`)}
date: ${postDate}
author: Grok
source: "link"
tags:
  - Bookmarks
---
`;

      // const fullMarkdown = frontMatter + '\n' + markdownBody + debugSection;

      // === NEW: Model & Skipped Sites Summary ===
      let summaryFooter = `\n\n### Generation Info\n`;
      summaryFooter += `**Model:** ${MODEL} (reasoningEffort: none)\n`;
      
      const skippedCount = withDates.filter(bm => 
        PROBLEMATIC_DOMAINS.some(domain => bm.url.includes(domain))
      ).length;
      
      if (skippedCount > 0) {
        summaryFooter += `**Skipped domains:** ${PROBLEMATIC_DOMAINS.join(', ')} (${skippedCount} bookmarks skipped for scraping but still analyzed)\n`;
      } else {
        summaryFooter += `**Skipped domains:** None\n`;
      }
      summaryFooter += `\n(Images may be omitted when enrichment fails or domains are skipped.)\n`;
      // ===========================================

      const fullMarkdown = frontMatter + '\n' + markdownBody + debugSection + summaryFooter;      

      await fs.mkdir(OUTPUT_DIR, { recursive: true });

      // 3. Collision-Proof Resolution Loop (Asynchronous)
      let baseFilename = `links-${safeTimestamp}`;
      let finalFilePath = path.join(OUTPUT_DIR, `${baseFilename}.md`);
      let counter = 1;

      while (true) {
        try {
          // Check if the file path is already taken
          await fs.access(finalFilePath);
          // If it doesn't throw an error, file exists. Append an incremented suffix.
          finalFilePath = path.join(OUTPUT_DIR, `${baseFilename}-${counter}.md`);
          counter++;
        } catch {
          // fs.access throws an error if the file doesn't exist, meaning it is safe to write
          break;
        }
      }

      // 4. Write the uniquely verified file path
      await fs.writeFile(finalFilePath, fullMarkdown, 'utf8');

      console.log(`Generated blog post with debug section: posts/${path.basename(finalFilePath)}`);
      console.log(`Batch ${batchIndex} → ${validGroups.length} thread candidate folder(s) in ${X_OUTPUT_DIR}`);

      await fs.rm(X_OUTPUT_DIR, { recursive: true, force: true });
      await fs.mkdir(X_OUTPUT_DIR, { recursive: true });

      for (let i = 0; i < validGroups.length; i++) {
        await processGroupToFolder(validGroups[i], `t${i + 1}`, enriched);
      }
      
      console.log(`Generated ${validGroups.length} thread candidate folder(s) in ${X_OUTPUT_DIR} (batch ${batchIndex})`);

    } finally {
      if (sharedBrowser) {
        await sharedBrowser.close();
        console.log('Shared Firefox browser closed');
      }
    }

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
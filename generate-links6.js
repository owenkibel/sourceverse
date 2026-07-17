import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import ogs from 'open-graph-scraper';
import { firefox } from 'playwright';

const execAsync = promisify(exec);

// --- Configuration ---
const DEPTH = 40; // bookmarks per batch
const DEFAULT_MODEL = "grok-4.5"; 

const BOOKMARKS_PATH = '/home/owen/.config/google-chrome-unstable/Default/Bookmarks';
const OUTPUT_DIR = './posts';
const X_OUTPUT_DIR = './x';

const TRANSCRIPT_MAX_CHARS = process.argv.includes('--transcript=') 
  ? parseInt(process.argv.find(a => a.startsWith('--transcript='))?.split('=')[1] || '2500') 
  : 2500;

const BATCH_SIZE = DEPTH;
const batchArg = process.argv.find(a => a.startsWith('--batch='))?.split('=')[1] || '0';
const batchIndex = parseInt(batchArg, 10) || 0;

const YTDLP_TIMEOUT_MS = 45000;
const TEMP_DIR = os.tmpdir();

const PROBLEMATIC_DOMAINS = [ 
  'washingtonpost.com', 'nytimes.com', 'wsj.com', 'ft.com', 
  'theatlantic.com', 'newyorker.com', 'bloomberg.com', 'economist.com', 'usnews.com'
];

// --- Utilities ---

function normalizeUrl(u) {
  try {
    const parsed = new URL(u);
    if ((parsed.hostname.includes('youtube.com') || parsed.hostname.includes('youtu.be')) && parsed.searchParams.has('v')) {
      return `${parsed.hostname}/watch?v=${parsed.searchParams.get('v')}`;
    }
    let base = parsed.origin + parsed.pathname;
    return base.replace(/\/$/, '');
  } catch (e) {
    return u.split('?')[0].replace(/\/$/, '');
  }
}

function findBestMatchForUrl(url, enrichedData) {
  const videoID = getYouTubeVideoID(url);
  if (videoID) {
    const match = enrichedData.find(item => getYouTubeVideoID(item.url) === videoID);
    if (match) return match;
  }
  const normalized = normalizeUrl(url);
  let match = enrichedData.find(item => normalizeUrl(item.url) === normalized);
  if (match) return match;

  if (!videoID) {
    const urlSlug = url.split('/').pop().toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 15);
    return enrichedData.find(item => {
      const titleSlug = (item.og_title || item.original_title || '').toLowerCase()
        .replace(/[^a-z0-9]/g, '').substring(0, 15);
      return titleSlug && urlSlug && titleSlug.includes(urlSlug);
    }) || {};
  }
  return {};
}

function getYouTubeVideoID(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('youtube.com') || parsed.hostname.includes('youtu.be')) {
      if (parsed.pathname.startsWith('/shorts/') || parsed.pathname.startsWith('/embed/')) {
        return parsed.pathname.split('/')[2]?.split(/[?#]/)[0] || null;
      }
      if (parsed.hostname.includes('youtu.be')) {
        return parsed.pathname.substring(1).split(/[?#]/)[0] || null;
      }
      return parsed.searchParams.get('v');
    }
  } catch (e) {
    const regex = /(?:v=|\/shorts\/|\/embed\/|\/)([^&\n?#]+)/;
    const match = url.match(regex);
    return match ? match[1] : null;
  }
  return null;
}

function chromeDateToJsDate(chromeDateStr) {
  const microseconds = BigInt(chromeDateStr);
  const milliseconds = microseconds / 1000n;
  const epochDifference = 11644473600000n; 
  return new Date(Number(milliseconds - epochDifference));
}

function collectBookmarks(node, allBookmarks) {
  if (node.url) {
    allBookmarks.push({ name: node.name, url: node.url, date_added: node.date_added });
  }
  if (node.children) {
    for (const child of node.children) {
      collectBookmarks(child, allBookmarks);
    }
  }
}

function extractMainArticleText(html) {
  if (!html) return '';
  let targetHtml = html;
  
  const articleMatch = html.match(/<article[\s\S]*?>([\s\S]*?)<\/article>/i);
  if (articleMatch && articleMatch[1].trim().length > 200) {
    targetHtml = articleMatch[1];
  } else {
    const mainMatch = html.match(/<main[\s\S]*?>([\s\S]*?)<\/main>/i);
    if (mainMatch && mainMatch[1].trim().length > 200) {
      targetHtml = mainMatch[1];
    }
  }
  
  return targetHtml
    .replace(/<nav[\s\S]*?>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?>[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?>[\s\S]*?<\/aside>/gi, '')
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '')
    .replace(/<form[\s\S]*?>[\s\S]*?<\/form>/gi, '');
}

function chunkTextSmart(text, maxChunkSize = 20000) {
  const paragraphs = text.split('\n\n');
  const chunks = [];
  let currentChunk = '';
  
  for (const para of paragraphs) {
    const trimmedPara = para.trim();
    if (!trimmedPara) continue;
    
    if ((currentChunk + '\n\n' + trimmedPara).length > maxChunkSize) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = trimmedPara;
      } else {
        let subIndex = 0;
        while (subIndex < trimmedPara.length) {
          chunks.push(trimmedPara.substring(subIndex, subIndex + maxChunkSize));
          subIndex += maxChunkSize;
        }
      }
    } else {
      currentChunk = currentChunk ? currentChunk + '\n\n' + trimmedPara : trimmedPara;
    }
  }
  if (currentChunk) chunks.push(currentChunk.trim());
  return chunks;
}

async function extractAndAnalyzeAudio(url) {
  if (url.includes('/playlist?list=') || url.includes('/view_playlist') || url.includes('/channel/')) {
    console.log(`  [Audio Pipeline] Skipping playlist container URL.`);
    return "";
  }

  const videoID = getYouTubeVideoID(url) || url.replace(/https?:\/\/(www\.)?/, '').replace(/[^a-z0-9]/gi, '-').substring(0, 15);
  const runId = Date.now().toString(36);
  const tempRawAudio = path.join(TEMP_DIR, `raw-${videoID}-${runId}`);
  const tempProcessedWav = path.join(TEMP_DIR, `proc-${videoID}-${runId}.wav`);

  try {
    console.log(`  [Audio Pipeline] Verifying media asset stream availability...`);
    try {
      await execAsync(`yt-dlp --simulate --quiet --no-warnings --match-filter "vcodec != null || acodec != null" "${url}"`);
    } catch (e) {
      console.log(`  [Audio Pipeline] Bypassing: No valid audio or video tracks detected at target.`);
      return "";
    }

    console.log(`  [Audio Pipeline] Extracting initial 30s section via range stream...`);
    await execAsync(
      `yt-dlp --download-sections "*00:00-00:30" -f "ba/b/bestaudio/best" -x --audio-format wav --no-playlist --quiet --no-warnings --extractor-args "youtube:player_client=web" --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" -o "${tempRawAudio}" "${url}"`,
      { timeout: 45000 }
    );
    
    const files = await fs.readdir(TEMP_DIR);
    const actualRawFile = files.find(f => f.startsWith(`raw-${videoID}-${runId}`));
    if (!actualRawFile) throw new Error("Range stream extraction failed to produce a temporary block.");

    console.log(`  [Audio Pipeline] Normalizing file format to 16kHz mono PCM for Gemma 4...`);
    await execAsync(
      `ffmpeg -y -i "${path.join(TEMP_DIR, actualRawFile)}" -ar 16000 -ac 1 -c:a pcm_f32le "${tempProcessedWav}"`
    );

    const wavBuffer = await fs.readFile(tempProcessedWav);
    const base64Audio = wavBuffer.toString('base64');

    await fs.unlink(path.join(TEMP_DIR, actualRawFile)).catch(() => {});
    await fs.unlink(tempProcessedWav).catch(() => {});

    console.log(`  [Audio Pipeline] Dispatching sensory vector arrays to local llama-server...`);
    const response = await fetch("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemma-4-E4B-it-GGUF",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Analyze this raw audio sample. Extrapolate on any verbal messaging, vocal pacing, mood markers, emotional delivery, speaker switches, and overall clarity." },
            { type: "input_audio", input_audio: { data: base64Audio, format: "wav" } }
          ]
        }]
      })
    });

    if (!response.ok) throw new Error(`Local backend engine returned status: ${response.status}`);
    const data = await response.json();
    return `\n\n[Local Gemma 4 Audio Analysis]:\n${data.choices[0].message.content.trim()}`;

  } catch (err) {
    console.warn(`  ⚠️ Local multimodal audio processing bypassed: ${err.message}`);
    await fs.unlink(tempProcessedWav).catch(() => {});
    return "";
  }
}

// --- Dynamic Content Scraping Fallbacks ---

async function fetchWithPlaywright(url, browser, skipTruncate = false) {
  let attempts = 0;
  const maxAttempts = 2;
  while (attempts < maxAttempts) {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      
      if (url.includes('x.com') || url.includes('twitter.com')) {
        await page.evaluate(async () => {
          for (let i = 0; i < 3; i++) {
            window.scrollBy(0, 800);
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        });
      } else {
        await page.waitForTimeout(2000);
      }

      const data = await page.evaluate((targetUrl) => {
        const ogTitle = document.title || document.querySelector('meta[property="og:title"]')?.content || '';
        
        if (targetUrl.includes('x.com') || targetUrl.includes('twitter.com')) {
          const tweetElements = Array.from(document.querySelectorAll('[data-testid="tweetText"], article div[dir="auto"]'))
            .map(el => el.innerText.trim())
            .filter(t => t.length > 15);
            
          const structuralHeader = document.querySelector('[data-testid="sidebarColumn"] h2, h2 span, h1')?.innerText || ogTitle;
          
          return {
            ogTitle: structuralHeader.trim(),
            paragraphs: tweetElements,
            ogImage: document.querySelector('meta[property="og:image"]')?.content || null
          };
        }

        document.querySelectorAll('nav, footer, header, aside, .sidebar, .menu, .nav, #footer, #header, #sidebar, form').forEach(el => el.remove());
        const paragraphs = Array.from(document.querySelectorAll('p, .prose p, .rich-text p, div[dir="auto"] p'))
          .map(p => p.innerText.trim())
          .filter(t => t.length > 40);

        let images = Array.from(document.querySelectorAll('img[src^="https://pbs.twimg.com/media/"], img[alt*="image"]'))
          .map(el => el.src)
          .filter(src => src && src.includes('pbs.twimg.com') && !src.includes('profile'));

        return {
          ogTitle: ogTitle.trim(),
          paragraphs: paragraphs,
          ogImage: images[0] || null,
        };
      }, url);

      await context.close();
      
      if (data && data.paragraphs) {
        const processedParas = skipTruncate ? data.paragraphs : data.paragraphs.slice(0, 80);
        return {
          ogTitle: data.ogTitle,
          ogDescription: processedParas.join('\n\n').trim(),
          ogImage: data.ogImage
        };
      }
      return null;
    } catch (error) {
      attempts++;
      console.warn(`Playwright attempt ${attempts}/${maxAttempts} failed for ${url}: ${error.message}`);
      await context.close();
      if (attempts >= maxAttempts) return null;
      await new Promise(resolve => setTimeout(resolve, 4000));
    }
  }
}

async function extractYouTubeTranscript(url, skipTruncate = false) {
  if (url.includes('music.youtube.com')) return { transcript: '', cacheReused: false };
  const videoID = getYouTubeVideoID(url);
  if (!videoID) {
    console.warn(`  Could not parse a valid Video ID from URL: ${url}`);
    return { transcript: '', cacheReused: false };
  }

  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const vttPath = path.join(TEMP_DIR, `${videoID}-${runId}.en.vtt`);

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
    console.log(`  Running yt-dlp for transcript (ID: ${videoID})`);
    await execAsync(`yt-dlp --write-auto-sub --skip-download --sub-lang en --sub-format vtt --no-playlist -o "${TEMP_DIR}/${videoID}-${runId}" "${url}"`, { timeout: YTDLP_TIMEOUT_MS, stdio: 'ignore' });
    transcript = await fs.readFile(vttPath, 'utf8');
  } catch (e) {
    try {
      const files = await fs.readdir(TEMP_DIR);
      const cachedFile = files.find(f => f.startsWith(videoID) && f.endsWith('.en.vtt'));
      if (cachedFile) {
        transcript = await fs.readFile(path.join(TEMP_DIR, cachedFile), 'utf8');
        cacheReused = true;
      }
    } catch (e2) {}
  }

  await fs.unlink(vttPath).catch(() => {});

  if (!transcript || !transcript.includes('WEBVTT')) return { transcript: '', cacheReused: false };

  const lines = transcript.split('\n');
  const transcriptLines = [];
  let inCue = false;

  for (let rawLine of lines) {
    let line = rawLine.trim();
    if (!line) continue;
    if (line === 'WEBVTT' || line.startsWith('Kind:') || line.startsWith('Language:') || line.startsWith('Style:') || line.startsWith('NOTE') || line.includes('-->')) {
      inCue = line.includes('-->');
      continue;
    }
    if (inCue || transcriptLines.length > 0) {
      line = line.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, ' ').trim();
      if (line) transcriptLines.push(line);
    }
  }

  let cleanTranscript = transcriptLines.join(' ').replace(/\s+/g, ' ').trim();

  if (!skipTruncate && cleanTranscript.length > TRANSCRIPT_MAX_CHARS) {
    cleanTranscript = cleanTranscript.substring(0, TRANSCRIPT_MAX_CHARS) + '\n\n[Transcript truncated]';
  }
  return { transcript: cleanTranscript, cacheReused };
}

// --- Versification Engine Branch ---

async function runVersificationMode(url, targetModel) {
  console.log(`\n🚀 Entering Versification Mode for URL: ${url}`);
  console.log(`   Target Processing Engine: ${targetModel}`);
  let sharedBrowser = await firefox.launch({ headless: true });
  let fullText = '';
  let title = 'Untitled Resource';

  let targetFetchUrl = url;
  if (targetFetchUrl.includes('music.youtube.com/watch?v=')) {
    const videoId = getYouTubeVideoID(targetFetchUrl);
    if (videoId) targetFetchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  }

  if (targetFetchUrl.includes('youtube.com') || targetFetchUrl.includes('youtu.be')) {
    const transcriptResult = await extractYouTubeTranscript(targetFetchUrl, true);
    fullText = transcriptResult.transcript;
    try {
      const { result } = await ogs({ url: targetFetchUrl, timeout: 12000 });
      if (result?.ogTitle) title = result.ogTitle;
    } catch (e) {}
  } else {
    let ogsSuccess = false;
    try {
      const { result, html } = await ogs({ url: targetFetchUrl, timeout: 12000 });
      if (result?.ogTitle) title = result.ogTitle;
      if (html) {
        const cleanHtml = extractMainArticleText(html);
        const sanitizeHtml = (await import('sanitize-html')).default;
        const sanitizedHtml = sanitizeHtml(cleanHtml, { allowedTags: ['main', 'article', 'p', 'h1', 'h2', 'h3', 'section'] });
        const { convert } = await import('html-to-text');
        fullText = convert(sanitizedHtml, { wordwrap: false }).replace(/\s+/g, ' ').trim();
        if (fullText.length > 200) ogsSuccess = true;
      }
    } catch (e) {}

    if (!ogsSuccess) {
      const pwData = await fetchWithPlaywright(targetFetchUrl, sharedBrowser, true);
      if (pwData) {
        title = pwData.ogTitle || title;
        fullText = pwData.ogDescription || '';
      }
    }
  }
  await sharedBrowser.close();

  if (!fullText || fullText.trim().length === 0) {
    console.error("❌ Error: Extraction completely empty. Versification cannot proceed.");
    process.exit(1);
  }

  console.log(`Extracted text payload length: ${fullText.length} characters. Fracturing into stanzas...`);
  const chunks = chunkTextSmart(fullText, 20000); 
  let activePoemBody = '';

  // Configure endpoint parameters dynamically based on model targets
  let apiUrl = 'https://api.x.ai/v1/chat/completions';
  let headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
  };

  for (let i = 0; i < chunks.length; i++) {
    console.log(`\n[Chunk ${i + 1}/${chunks.length}] Dispatching Context Block...`);
    
    let prompt = `You are an elite traditional poet. Adapt this text segment into high-quality, deeply insightful, truthful, and humorous traditional rhymed and metrical verse.
Guidelines:
- Arrange layout into distinct, coherent stanzas.
- Adhere strictly to traditional rhyme schemes (e.g. AABB or ABAB) and rhythm (e.g. flawless iambic pentameter or ballad meter). Avoid loose slant rhymes.
- Infuse the verses with intellectual depth, facts derived exactly from the text, and clever humor.
- Do not add text wraps, intro summaries, conversational remarks, or markdown code fences. Output the raw text poem only.

Text Segment:
${chunks[i]}`;

    if (i > 0) {
      prompt += `\n\nCRITICAL STRATEGY: This must naturally continue our long-form creation. Here are your previously written stanzas. Maintain the identical meter, structural format, rhyme rhythm, and comedic tone seamlessly:\n${activePoemBody}`;
    }

    let bodyPayload = {};
    if (targetModel.startsWith('gemma')) {
      apiUrl = 'http://localhost:8080/v1/chat/completions';
      headers = { 'Content-Type': 'application/json' };
      bodyPayload = {
        model: targetModel === "gemma-12b" ? "unsloth/gemma-4-12b-it-GGUF:UD-Q4_K_XL" : "ggml-org/gemma-4-E4B-it-GGUF",
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.65, // Lower temperature keeps local structural rhyme metrics precise
        max_tokens: 4096
      };
    } else {
      bodyPayload = {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.85,
        max_tokens: 4096, 
        reasoning_effort: "low",
      };
    }

try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(bodyPayload),
      });

      if (!response.ok) throw new Error(`API Status: ${response.status}`);
      const apiData = await response.json();
      
      const message = apiData.choices[0].message;
      let stanzas = (message.content || '').trim();
      
      // FALLBACK: If standard content is empty, pull the text from the reasoning stream
      if (!stanzas && message.reasoning_content) {
        console.log(`   [Engine Note] Standard content empty. Extracting from reasoning_content...`);
        stanzas = message.reasoning_content.trim();
        
        // Clean out any raw thinking/thought syntax wrapper remnants if present
        stanzas = stanzas.replace(/<thought>|<\/thought>|Thinking\.\.\.|\.\.\.done thinking\./gi, '').trim();
      }
      
      if (!stanzas) {
        console.warn(`⚠️ Warning: Both content and reasoning payload returned blank strings.`);
      }

      console.log(`[Chunk ${i + 1}/${chunks.length}] Generation successful.`);
      activePoemBody += (activePoemBody ? '\n\n' : '') + stanzas;
    } catch (err) {
      console.error(`❌ Failed on chunk ${i + 1}:`, err.message);
      break;
    }
  }

  // Inject line breaks into standalone verse records
  activePoemBody = activePoemBody.split('\n').map(line => {
    const trimmed = line.trim();
    if (trimmed !== '') return line.trimEnd() + '  ';
    return line;
  }).join('\n');

  const now = new Date();
  const timestamp = now.toISOString();
  const safeTimestamp = timestamp.replace(/[:.]/g, '-').toLowerCase();

  const frontMatter = `---
title: ${JSON.stringify(`Verse: ${title}`)}
date: ${timestamp}
author: ${targetModel.startsWith('gemma') ? 'Gemma4' : 'Grok'}
---`;

  const finalMarkdownOutput = `${frontMatter}\n\n[${JSON.stringify(url)}](${JSON.stringify(url)})\n\n${activePoemBody}`;
  const urlSlug = url.replace(/https?:\/\/(www\.)?/, '').replace(/[^a-z0-9]/gi, '-').toLowerCase().substring(0, 25);
  const fileTarget = path.join(OUTPUT_DIR, `verse-${urlSlug}-${safeTimestamp}.md`);
  
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(fileTarget, finalMarkdownOutput + '\n');
  console.log(`\n======================================================\n🎉 Creation finalized and preserved as Markdown at:\n👉 ${fileTarget}\n======================================================\n`);
}

// --- Main Standard Loop Code ---

async function processGroupToFolder(groupContent, folderName, enrichedData) {
  const folderPath = path.join(X_OUTPUT_DIR, folderName);
  await fs.mkdir(folderPath, { recursive: true });

  const lines = groupContent.split('\n');
  let title = ''; let poemLines = []; let items = []; let foundFirstBullet = false;

  if (lines[0]?.startsWith('## ')) title = lines[0].substring(3).trim();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      if (!foundFirstBullet) {
        poemLines.push(''); 
      }
      continue;
    }
    if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
      foundFirstBullet = true; items.push(line);
    } else if (foundFirstBullet) {
      items[items.length - 1] += '\n' + line;
    } else {
      poemLines.push(line);
    }
  }

  let processedPoemLines = [];
  for (let line of poemLines) {
    let cleanLine = line.trim().replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1').replace(/_{1,3}([^_]+)_{1,3}/g, '$1');
    if (cleanLine === '') {
      processedPoemLines.push('');
    } else {
      processedPoemLines.push(cleanLine + '  '); 
    }
  }
  let poem = processedPoemLines.join('\n').trim();

  const mainUrls = []; const itemTexts = [];

  for (const item of items) {
    const linkMatch = item.match(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/);
    if (!linkMatch) continue;
    
    const linkTitle = linkMatch[1].replace(/\*/g, '').trim(); 
    const url = linkMatch[2].replace(/[)\*]+$/, '').trim();
    
    let description = item.replace(/^[-\*\s\+]+(\*\*\/)?\[[^\]]+\]\([^\)]+\)[:\s\*\*]*/g, '').trim();
    description = description.replace(/[\*\s:]+$/g, '').trim();

    const cleanText = description || linkTitle;
    if (cleanText) { 
      itemTexts.push(cleanText); 
      mainUrls.push(url); 
    }
  }

  const threadPayload = { thread_id: folderName, title: title || 'Untitled Thread', grok_poem: poem || '', sources: [] };
  let plainText = ''; if (title) plainText += `${title}\n\n`; if (poem) plainText += `${poem}\n\n`;

  for (let i = 0; i < itemTexts.length; i++) {
    const currentUrl = mainUrls[i];
    const sourceData = findBestMatchForUrl(currentUrl, enrichedData);
    
    threadPayload.sources.push({ 
      url: currentUrl, 
      description_short: itemTexts[i], 
      og_title: sourceData.og_title || itemTexts[i], 
      rich_text: sourceData.og_description || null, 
      og_image: sourceData.og_image || null 
    });

    let bullet = `- **[${sourceData.og_title || itemTexts[i]}](${currentUrl})**: ${itemTexts[i]}`;
    if (sourceData.og_image && sourceData.og_image.startsWith('http')) {
      bullet += `\n  ![thumbnail](${sourceData.og_image})`;
    } else {
      bullet += `\n  ![thumbnail](https://via.placeholder.com/400x225/222222/FFFFFF?text=No+Image)`;
    }
    plainText += bullet + '\n\n';
  }

  await fs.writeFile(path.join(folderPath, 'payload.json'), JSON.stringify(threadPayload, null, 2) + '\n');
  await fs.writeFile(path.join(folderPath, 'x-thread.txt'), plainText.trim() + '\n');
}

async function main() {
  try {
    const urlArg = process.argv.find(a => a.startsWith('--url='))?.substring(6);
    if (urlArg) {
      let targetModel = "grok-4.5";
      if (process.argv.includes('--12b')) targetModel = "gemma-12b";
      if (process.argv.includes('--e4b')) targetModel = "gemma-e4b";
      await runVersificationMode(urlArg, targetModel);
      return;
    }

    const rawData = await fs.readFile(BOOKMARKS_PATH, 'utf8');
    const bookmarksJson = JSON.parse(rawData);
    const allBookmarks = [];
    for (const key of Object.keys(bookmarksJson.roots)) {
      collectBookmarks(bookmarksJson.roots[key], allBookmarks);
    }

    const sortedBookmarks = allBookmarks
      .map(bm => ({ ...bm, date: chromeDateToJsDate(bm.date_added) }))
      .sort((a, b) => b.date - a.date);

    const withDates = sortedBookmarks.slice(batchIndex * BATCH_SIZE, (batchIndex + 1) * BATCH_SIZE);
    console.log(`Processing batch ${batchIndex} → bookmarks ${batchIndex * BATCH_SIZE + 1}–${(batchIndex + 1) * BATCH_SIZE} (${withDates.length} items)`);

    let sharedBrowser = await firefox.launch({ headless: true });

    const timeout = (promise, ms, url) => {
      let timerId;
      const timeoutPromise = new Promise((_, reject) => { timerId = setTimeout(() => reject(new Error(`Enrichment timeout after ${ms}ms for ${url}`)), ms); });
      return Promise.race([promise.then((v) => { clearTimeout(timerId); return v; }), timeoutPromise]);
    };

    const enriched = await Promise.all(withDates.map(async (bm, index) => {
      console.log(`\n[${index + 1}/${withDates.length}] Processing: ${bm.name} – ${bm.url}`);

      const isProblematic = PROBLEMATIC_DOMAINS.some(domain => bm.url.includes(domain));
      if (isProblematic) {
        return { original_title: bm.name, url: bm.url, added_at: bm.date.toISOString(), og_title: bm.name, og_description: '[Skipped — known problematic domain]', og_image: null };
      }

      try {
        return await timeout((async () => {
          let targetFetchUrl = bm.url;
          if (targetFetchUrl.includes('music.youtube.com/watch?v=')) {
            const videoId = getYouTubeVideoID(targetFetchUrl);
            if (videoId) targetFetchUrl = `https://www.youtube.com/watch?v=${videoId}`;
          }

          let ogData = { ogTitle: bm.name || '(no title)', ogDescription: '', ogImage: null };
          let ogsSuccess = false;

          try {
            const { result, html } = await ogs({ url: targetFetchUrl, timeout: 12000 });
            if (result?.ogTitle) {
              ogData.ogTitle = result.ogTitle || bm.name;
              ogData.ogDescription = result.ogDescription || '';
              ogData.ogImage = Array.isArray(result.ogImage) ? result.ogImage[0]?.url : result.ogImage;
              ogsSuccess = true;

              if (html && !targetFetchUrl.includes('youtube.com') && !targetFetchUrl.includes('x.com')) {
                const { convert } = await import('html-to-text');
                const sanitizeHtml = (await import('sanitize-html')).default;
                
                const layoutCleanHtml = extractMainArticleText(html);
                const sanitizedHtml = sanitizeHtml(layoutCleanHtml, { allowedTags: ['main', 'article', 'p', 'h1', 'h2', 'h3', 'section'] });
                const mainText = convert(sanitizedHtml, { wordwrap: false }).replace(/\s+/g, ' ').trim();

                if (mainText.length > 200) {
                  const articleText = mainText.length > 2500 ? mainText.substring(0, 2500) + '... [Truncated]' : mainText;
                  ogData.ogDescription += `\n\nFull Article Text:\n${articleText}`;
                  console.log(`  Extracted and appended layout-filtered HTML body (~${articleText.length} chars)`);
                }
              }
            }
          } catch (e) { console.warn(`  OGS failed for ${targetFetchUrl}: ${e.message}`); }

          let transcriptResult = { transcript: '', cacheReused: false };
          const isMediaCapablePlatform = targetFetchUrl.includes('youtube.com') || targetFetchUrl.includes('youtu.be') || targetFetchUrl.includes('x.com') || targetFetchUrl.includes('twitter.com');

          if (isMediaCapablePlatform) {
            if ((targetFetchUrl.includes('youtube.com') || targetFetchUrl.includes('youtu.be')) && !bm.url.includes('music.youtube.com')) {
              transcriptResult = await extractYouTubeTranscript(targetFetchUrl, false);
            }
            
            if (!transcriptResult.transcript) {
              console.log(`  Text metadata absent or skipped. Initiating local sensory audio pipeline...`);
              const soundscapeAnalysis = await extractAndAnalyzeAudio(targetFetchUrl);
              if (soundscapeAnalysis) {
                transcriptResult.transcript = soundscapeAnalysis;
              }
            }
          }

          let descriptionParts = [];
          if (transcriptResult.transcript) descriptionParts.push(`Audio Enrichment Context:\n\n${transcriptResult.transcript}`);
          if (ogsSuccess && ogData.ogDescription?.trim()) {
            const ogsText = ogData.ogDescription.trim();
            if (ogsText && (!transcriptResult.transcript || !ogsText.toLowerCase().includes(transcriptResult.transcript.substring(0, 200).toLowerCase()))) {
              descriptionParts.push(`\n\nOriginal Page Description:\n\n${ogsText}`);
            }
          }
          ogData.ogDescription = descriptionParts.join('') || ogData.ogDescription;

          if (!transcriptResult.transcript && !ogsSuccess) {
            console.log(`  Falling back to Playwright for ${targetFetchUrl}`);
            const pwData = await fetchWithPlaywright(targetFetchUrl, sharedBrowser, false);
            if (pwData) {
              ogData.ogTitle = pwData.ogTitle || ogData.ogTitle;
              ogData.ogDescription = pwData.ogDescription || ogData.ogDescription;
              ogData.ogImage = pwData.ogImage || ogData.ogImage;
            }
          }

          return { original_title: bm.name, url: bm.url, added_at: bm.date.toISOString(), og_title: ogData.ogTitle, og_description: ogData.ogDescription, og_image: ogData.ogImage, transcript_cache_reused: transcriptResult.cacheReused };
        })(), 45000, bm.url);
      } catch (err) {
        console.warn(`  ⚠️ Enrichment failed/timed out for ${bm.url}`);
        return { original_title: bm.name, url: bm.url, added_at: bm.date.toISOString(), og_title: bm.name, og_description: '[Enrichment failed]', og_image: null };
      }
    }));

    await sharedBrowser.close();

    const now = new Date(); const timestamp = now.toISOString(); const safeTimestamp = timestamp.replace(/[:.]/g, '-');
    
    const fullPrompt = `You are Grok, an expert curator creating a sophisticated personal blog post from recent bookmarks.
Here are my ${enriched.length} most recent bookmarks (as of ${now.toDateString()}), enriched with Open Graph metadata and (where available) full long-form text from Premium X posts, article bodies, trending topics, threads, and YouTube transcripts:
${JSON.stringify(enriched, null, 2)}
Your task is to produce a high-quality curated post using advanced grouping techniques:- Employ sophisticated thematic analysis: detect latent connections, narrative arcs, opposing viewpoints, chronological progressions, intersections with current events, and deeper conceptual clusters.- Create 5–12 meaningful, thematically coherent groups (aim to include as many bookmarks as possible; prefer more focused clusters over very broad ones while avoiding superficial or forced groupings).- Choose precise, evocative topic names.
For each group:- Start with "## Topic Name"- Follow immediately with a classical rhymed and metrical poem (e.g., Shakespearean sonnet, Petrarchan sonnet, limerick sequence, heroic couplets, or similar form) that serves as an engaging, insightful preamble capturing the theme, context, and why it matters now. Present the entire poem in italicized Markdown by wrapping the whole poem block between * and * on their own lines (like a block). NEVER add **bold** around the ## group titles — output them exactly as plain ## Title Name.- Then list the relevant bookmarks as bullet points: - **[og_title](url)**: One sharp, engaging sentence description (hooky, informative, and additive; refine og_description or write your own if better).

Any true singletons go in a final "## Miscellaneous" section with the same format.
Output EXACTLY the complete clean markdown body for the blog post (starting with the first ## header; no extra text, no introductions, no closing remarks, no separators).`;

    console.log('Calling Grok API...');
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.XAI_API_KEY}` },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: fullPrompt }],
        temperature: 1,
        max_tokens: 12288,  
        reasoning_effort: "low",
      })
    });

    if (!response.ok) throw new Error(`Grok API error: ${response.status}`);
    const apiData = await response.json(); let markdownBody = apiData.choices[0].message.content.trim();

    let inGlobalPoemBlock = false;
    markdownBody = markdownBody.split('\n').map(line => {
      const trimmed = line.trim();
      if (trimmed === '*') {
        inGlobalPoemBlock = !inGlobalPoemBlock;
        return line;
      }
      if (inGlobalPoemBlock && trimmed !== '') {
        return line.trimEnd() + '  '; 
      }
      return line;
    }).join('\n');

    markdownBody = markdownBody.split('\n').map((line) => {
      const trimmed = line.trim();
      if ((trimmed.startsWith('- ') || trimmed.startsWith('* ')) && trimmed.includes('[') && trimmed.includes('](')) {
        const urlMatch = trimmed.match(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/);
        if (urlMatch) {
          const currentUrl = urlMatch[1].trim();
          const source = findBestMatchForUrl(currentUrl, enriched);
          let updatedLine = line;
          if (source.og_image && source.og_image.startsWith('http')) {
            updatedLine += `\n  ![thumbnail](${source.og_image})`;
          } else {
            updatedLine += `\n  ![thumbnail](https://via.placeholder.com/400x225/222222/FFFFFF?text=No+Image)`;
          }
          return updatedLine;
        }
      }
      return line;
    }).join('\n');

    let cleanedBody = markdownBody.replace(/\\*\\*##/g, '##').replace(/##\s+([^\n]+?)\\*\\*/g, '## $1').replace(/\n{3,}/g, '\n\n');
    
    const rawGroups = cleanedBody.split(/(?=^## )/m).map(g => g.trim()).filter(g => g.length > 30);
    console.log(`Raw groups detected: ${rawGroups.length}`);
    
    try {
      await fs.rm(X_OUTPUT_DIR, { recursive: true, force: true });
      console.log(`🧹 Cleared old thread directories in ${X_OUTPUT_DIR} for a fresh run.`);
    } catch (e) {
      console.warn(`⚠️ Warning: Could not clear ${X_OUTPUT_DIR}: ${e.message}`);
    }

    let folderCounter = 1;
    for (const group of rawGroups) {
      if (group.startsWith('## ')) {
        const structuralFolderName = `t${folderCounter}`;
        folderCounter++;
        await processGroupToFolder(group, structuralFolderName, enriched);
      }
    }

    const frontMatter = `---\ntitle: "Links ${timestamp}"\ndate: ${new Date().toISOString()}\nauthor: Grok\ntags:\n  - Bookmarks\n---`;
    const finalFilePath = path.join(OUTPUT_DIR, `links-${safeTimestamp.toLowerCase()}.md`);
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    await fs.writeFile(finalFilePath, frontMatter + '\n' + markdownBody + '\n');
    console.log(`Processed batch successfully. Saved folder structures and main file to: ${finalFilePath}`);
  } catch (error) {
    console.error("Fatal exception inside main run tracker:", error);
  }
}

main();
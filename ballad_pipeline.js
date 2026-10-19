const path = require('path');
const fs = require('fs/promises');
const { existsSync, copyFileSync, writeFileSync } = require('fs');
const os = require('os');
const { execFile, spawnSync } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

const POSTS_DIR = path.join(process.cwd(), 'posts');
const IMAGES_DIR = path.join(process.cwd(), 'images');
const ASTRO_PUBLIC_IMAGES = path.join(process.cwd(), 'site/public/images');
const DEFAULT_REF_POOL_DIR = path.join(process.cwd(), 'ref_audio_pool');

const RAW_ACE_STYLES = [
  "Acid House", "Acid Techno", "Alternative / Indie", "Alternative Rock", "Ambient",
  "Americana", "Bluegrass", "Blues", "Bossa Nova", "Celtic Folk", "Chamber",
  "Chillwave", "Classical", "Coldwave", "Country", "Dark Ambient", "Darksynth",
  "Darkwave", "Disco", "Downtempo", "Dream Pop", "Electro", "Electro-Jazz",
  "Electro-Swing", "Electronic", "Electropop", "Experimental", "Fado",
  "Flamenco / Bulerias", "Folk", "French House", "Funk", "Gothic", "Hard Rock",
  "Heavy Metal", "Hip Hop / Rap", "House", "IDM", "Indie Folk", "Industrial",
  "Instrumental", "Irish Folk", "Italo Disco", "Jazz", "Lo-Fi Hip Hop",
  "Math Rock", "Melodic Techno", "Metal", "Minimal Techno", "New Age", "New Wave",
  "Organic House", "Pop", "Pop Rock", "Post-Punk", "Post-Rock",
  "Progressive Electronic", "Progressive House", "Progressive Rock", "Psychedelia",
  "Punk Rock", "R&B", "Reggae", "Rock", "Rockabilly", "Shoegaze", "Ska",
  "Soft Rock", "Soul", "Surf Music", "Synthpop", "Synthwave", "Tango",
  "Tech House", "Techno", "Trance", "Trip Hop", "World Music"
];

const VOICE_CYCLE = [
  "Bass-Baritone male vocals",
  "Mezzo-Soprano female vocals",
  "Lyric Tenor male vocals",
  "Dramatic Soprano female vocals"
];

// =========================================================================
// CLI FLAGS (Matches vertical_thread17_5.js conventions)
// =========================================================================
const args = process.argv.slice(2);

let t2iModel = "krea"; // Default to Krea or override with --t2i zturbo|lens|qwen|krea
const t2iArgIndex = args.findIndex(a => a === "--t2i" || a === "-t");
if (t2iArgIndex !== -1 && args[t2iArgIndex + 1]) {
  t2iModel = args[t2iArgIndex + 1].toLowerCase();
}
const useKrea = args.includes('--krea') || t2iModel.startsWith('krea');
const useLens = args.includes('--lens') || t2iModel === 'lens';
const useQwen = args.includes('--qwen') || t2iModel.startsWith('qwen');
const useGeminiImage = args.includes('--gemini-image');

const useYue = args.includes('--yue') || args.includes('--yue2');
const useVideo = args.includes('--ltx') || args.includes('--video');
const forceT2V = args.includes('--t2v');
const skipTTS = args.includes('--no-tts');
const skipSong = args.includes('--no-song');
const forceReprocess = args.includes('--force');

let generationDuration = 128;
const durArg = args.find(a => a.startsWith('--duration='));
if (durArg) generationDuration = parseInt(durArg.split('=')[1], 10) || 128;

const dirArg = args.find(a => a.startsWith('--dir='));
const targetScanDir = dirArg
  ? path.resolve(process.cwd(), dirArg.split('=')[1])
  : POSTS_DIR;

const rawRefArg = args.find(a => /^--?ref-audio(=|$)/i.test(a));
const refAudioSetting = rawRefArg
  ? (rawRefArg.includes('=') ? rawRefArg.split('=').slice(1).join('=').trim() : 'pool')
  : null;

const slugify = (t) =>
  (t || 'ballad')
    .toString()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

async function safeUnlink(filePath) {
  if (!filePath) return;
  try { await fs.unlink(filePath); } catch (_) {}
}

function mirrorToAstroPublic(srcPath, filename) {
  if (existsSync(ASTRO_PUBLIC_IMAGES)) {
    try {
      copyFileSync(srcPath, path.join(ASTRO_PUBLIC_IMAGES, filename));
    } catch (_) {}
  }
}

async function freeComfyVRAM() {
  console.log("🧹 Releasing local ComfyUI VRAM nodes...");
  try {
    await fetch('http://127.0.0.1:8188/free', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true })
    });
  } catch (_) {}
}

async function resolveReferenceAudio(refArgValue) {
  if (!refArgValue) return null;
  let targetPoolDir = DEFAULT_REF_POOL_DIR;

  if (refArgValue !== 'true' && refArgValue !== 'pool' && refArgValue !== 'auto') {
    try {
      const stats = await fs.stat(refArgValue);
      if (stats.isFile()) return refArgValue;
      if (stats.isDirectory()) targetPoolDir = refArgValue;
    } catch (_) {}
  }

  try {
    const entries = await fs.readdir(targetPoolDir);
    const audioFiles = entries.filter(f => /\.(opus|mp4|wav|flac|mp3)$/i.test(f));
    if (audioFiles.length > 0) {
      const chosen = audioFiles[Math.floor(Math.random() * audioFiles.length)];
      return path.join(targetPoolDir, chosen);
    }
  } catch (_) {}
  return null;
}

// =========================================================================
// MARKDOWN PARSER FOR EPISTEMIC BALLADEER EXPORTS
// =========================================================================
function parseBalladMarkdown(rawMd) {
  const fmMatch = rawMd.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fmMatch) return null;

  const frontMatterRaw = fmMatch[1];
  const body = fmMatch[2];

  // Check if this is an Epistemic Balladeer file (and not an Archive Index)
  const isBallad =
    frontMatterRaw.includes('epistemic_strategy:') ||
    frontMatterRaw.includes('source: "balladeer"');
  const isIndex = frontMatterRaw.includes('form: "INDEX"');
  const alreadyEnriched = frontMatterRaw.includes('media_enriched: true');

  if (!isBallad || isIndex) return null;

  const titleMatch = frontMatterRaw.match(/^title:\s*"(.*)"/m);
  const title = titleMatch ? titleMatch[1].replace(/\\"/g, '"') : 'Epistemic Ballad';

  // 1. Extract Poem Stanzas (between # TITLE and the first ---)
  let poemText = '';
  const poemSectionMatch = body.match(/^#\s+[^\n]+\n+([\s\S]*?)\n+---/m);
  if (poemSectionMatch) {
    poemText = poemSectionMatch[1].trim();
  }

  // 2. Extract Style Tags
  let styleTags = 'Folk, Classical, Baroque chamber ballad, Bass-Baritone male vocals';
  const tagsMatch = body.match(/### Style & Instrumentation Tags\s+```(?:text)?\n([\s\S]*?)```/i);
  if (tagsMatch && tagsMatch[1].trim()) {
    styleTags = tagsMatch[1].trim();
  }

  // 3. Extract Structured Lyrics
  let structuredLyrics = poemText;
  const lyricsMatch = body.match(/### Structured Lyrics\s+```(?:text)?\n([\s\S]*?)```/i);
  if (lyricsMatch && lyricsMatch[1].trim()) {
    structuredLyrics = lyricsMatch[1].trim();
  }

  // 4. Extract Cover Art Prompt
  let coverArtPrompt = `Period broadside illustration for ${title}, theatrical lighting, detailed engraving`;
  const artMatch = body.match(/### Cover Art \/ Keyframe Prompt\s+```(?:text)?\n([\s\S]*?)```/i);
  if (artMatch && artMatch[1].trim()) {
    coverArtPrompt = artMatch[1].trim();
  }

  return {
    frontMatterRaw,
    body,
    title,
    alreadyEnriched,
    poemText,
    styleTags,
    structuredLyrics,
    coverArtPrompt
  };
}

function sanitizeTagsForAceStep(rawTags, fallbackVoice) {
  const voiceMatch = rawTags.match(
    /(bass-baritone|mezzo-soprano|lyric tenor|dramatic soprano|baritone|soprano|tenor)[^,]*/i
  );
  const voiceTag = voiceMatch ? voiceMatch[0].trim() : fallbackVoice;

  const tokens = rawTags
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);

  const matchedAce = tokens.filter(t =>
    RAW_ACE_STYLES.some(s => s.toLowerCase() === t.toLowerCase())
  );

  // Keep matched ACE-Step genres + descriptive instrumentation for YuE2/ACE-Step
  const baseGenres = matchedAce.length > 0 ? matchedAce.slice(0, 3) : ['Folk', 'Classical'];
  const descriptive = tokens
    .filter(t => !matchedAce.includes(t) && !/vocals/i.test(t))
    .slice(0, 4);

  return [...baseGenres, ...descriptive, voiceTag].join(', ');
}

// =========================================================================
// COMFYUI WORKER DISPATCHERS (Mirrors vertical_thread17_5.js)
// =========================================================================
async function runImageGen(prompt, slug) {
  if (useGeminiImage && process.env.GEMINI_API_KEY1) {
    const API_KEY = process.env.GEMINI_API_KEY1;
    const filename = `img_${slug}_${Date.now()}.jpg`;
    const dest = path.join(IMAGES_DIR, filename);
    try {
      console.log(`🤖 [Cloud Track] Querying Nano Banana 2 Lite (9:16)...`);
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-image:generateContent?key=${API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              responseModalities: ["TEXT", "IMAGE"],
              imageConfig: { aspectRatio: "9:16" }
            }
          })
        }
      );
      const data = await res.json();
      const part = (data.candidates?.[0]?.content?.parts || []).find(p => p.inlineData?.data);
      if (part) {
        writeFileSync(dest, Buffer.from(part.inlineData.data, 'base64'));
        mirrorToAstroPublic(dest, filename);
        return {
          success: true,
          filename,
          engine: 'Gemini Nano Banana 2 Lite',
          markdown: `<p><img src="/images/${filename}" style="max-width:100%; border-radius:8px;" alt="Ballad Visual Anchor" /></p>`
        };
      }
    } catch (e) {
      console.warn(`⚠️ Cloud image failed (${e.message}), falling back to local ComfyUI...`);
    }
  }

  const stateFile = path.join(os.tmpdir(), `ballad-img-${Date.now()}.json`);
  try {
    await fs.writeFile('prompt.txt', prompt || 'Broadside ballad illustration', 'utf8');
    const runnerScript = useKrea
      ? 'run_krea.js'
      : useLens
      ? 'run_lens.js'
      : useQwen
      ? 'run_qwen.js'
      : 'run_z_turbo.js';

    console.log(`🎨 [ComfyUI Image] Running ${runnerScript}...`);
    await execFileAsync('bun', [runnerScript, '--state-file', stateFile]);
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    const finalFilename = state.filename;

    if (finalFilename) {
      mirrorToAstroPublic(path.join(IMAGES_DIR, finalFilename), finalFilename);
      return {
        success: true,
        filename: finalFilename,
        engine: runnerScript.replace('run_', '').replace('.js', ''),
        markdown: `<p><img src="/images/${finalFilename}" style="max-width:100%; border-radius:8px;" alt="Ballad Visual Anchor" /></p>`
      };
    }
  } catch (e) {
    console.error(`❌ Image worker failed: ${e.message}`);
  } finally {
    await safeUnlink(stateFile);
    await safeUnlink('prompt.txt');
  }
  return { success: false, filename: '', engine: 'Failed', markdown: '' };
}

async function runPoetryTTS(poemText) {
  const stateFile = path.join(os.tmpdir(), `ballad-tts-${Date.now()}.json`);
  const poemFile = 'temp_poem.txt';
  try {
    console.log(`🎙️ [ComfyUI TTS] Synthesizing spoken ballad via run_kokoro_tts.js...`);
    await fs.writeFile(poemFile, poemText || 'Silence.', 'utf8');
    await execFileAsync('bun', ['run_kokoro_tts.js', '--state-file', stateFile, '--prompt-file', poemFile]);
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));

    const rawFlacPath = state.savedFilePath;
    const finalOpusFilename = state.filename.replace(/\.(flac|wav)$/, '.opus');
    const finalOpusPath = path.join(IMAGES_DIR, finalOpusFilename);

    const filterGraph = [
      '[0:a]loudnorm=I=-16:TP=-1.5:LRA=11[norm]',
      '[norm]stereotools=mlev=0.9:slev=1.2[wide]',
      '[wide]treble=g=3:f=6000:w=0.5[crisp]',
      '[crisp]alimiter=limit=-1.5dB[final_audio]'
    ].join(';');

    await execFileAsync('ffmpeg', [
      '-y', '-i', rawFlacPath,
      '-filter_complex', filterGraph, '-map', '[final_audio]',
      '-c:a', 'libopus', '-b:a', '128k', finalOpusPath
    ]);

    mirrorToAstroPublic(finalOpusPath, finalOpusFilename);
    await safeUnlink(rawFlacPath);

    return {
      success: true,
      filename: finalOpusFilename,
      engine: 'Kokoro TTS',
      markdown: `\n<p><audio controls src="/images/${finalOpusFilename}"></audio></p>\n`
    };
  } catch (e) {
    console.error(`❌ TTS synthesis failed: ${e.message}`);
    return { success: false, markdown: '' };
  } finally {
    await safeUnlink(stateFile);
    await safeUnlink(poemFile);
  }
}

async function runVideoGen(videoPrompt, anchorImageName) {
  const stateFile = path.join(os.tmpdir(), `ballad-vid-${Date.now()}.json`);
  try {
    console.log(`🎬 [ComfyUI Video] Running run_ltx_video.js...`);
    const runnerArgs = ['run_ltx_video.js', '--state-file', stateFile, '--prompt', videoPrompt];
    if (forceT2V || !anchorImageName) {
      runnerArgs.push('--t2v');
    } else {
      runnerArgs.push('--image', anchorImageName);
    }
    await execFileAsync('bun', runnerArgs);
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    const filename = state.filename || path.basename(state.savedFilePath);
    mirrorToAstroPublic(path.join(IMAGES_DIR, filename), filename);
    return {
      success: true,
      filename,
      engine: 'LTX-Video',
      markdown: `\n<p><video controls src="/images/${filename}" style="max-width:100%; border-radius:8px;" loop muted></video></p>\n`
    };
  } catch (e) {
    console.error(`❌ Video worker failed: ${e.message}`);
    return { success: false, markdown: '' };
  } finally {
    await safeUnlink(stateFile);
  }
}

async function runSongWorker(tags, lyrics, slug, duration, referenceAudio) {
  const stateFile = path.join(os.tmpdir(), `ballad-song-${Date.now()}.json`);
  const scriptName = useYue ? 'run_yue.js' : 'run_acestep.js';
  const prefix = useYue ? 'yue2' : 'acestep';

  try {
    console.log(`🎵 [ComfyUI Song] Running ${scriptName} (${duration}s)...`);
    const runnerArgs = [
      scriptName,
      '--state-file', stateFile,
      '--tags', tags,
      '--lyrics', lyrics,
      '--duration', duration.toString()
    ];

    let refAudioName = null;
    let refAudioMarkdown = '';

    if (referenceAudio) {
      runnerArgs.push('--ref-audio', referenceAudio);
      refAudioName = path.basename(referenceAudio);
      const destRefPath = path.join(IMAGES_DIR, refAudioName);
      try {
        await fs.copyFile(referenceAudio, destRefPath);
        mirrorToAstroPublic(destRefPath, refAudioName);
      } catch (_) {}
      refAudioMarkdown = `\n<div class="reference-audio-embed" style="margin: 0.75rem 0 1.25rem;">
  <p style="font-size: 0.85em; margin-bottom: 4px; opacity: 0.8;">🎧 <strong>Anchor Reference Audio (${refAudioName}):</strong></p>
  <audio controls src="/images/${refAudioName}"></audio>
</div>\n`;
    }

    // spawnSync passes multi-line lyrics safely without shell quote breaking
    spawnSync('bun', runnerArgs, { stdio: 'inherit' });

    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    const rawFlacPath = state.savedFilePath;
    const opusFilename = `${prefix}_${slug}_${Date.now()}.opus`;
    const opusPath = path.join(IMAGES_DIR, opusFilename);

    await execFileAsync('ffmpeg', [
      '-y', '-i', rawFlacPath,
      '-af', `afade=t=out:st=${Math.max(0, duration - 5)}:d=5`,
      '-c:a', 'libopus', '-b:a', '128k', opusPath
    ]);
    mirrorToAstroPublic(opusPath, opusFilename);
    await safeUnlink(rawFlacPath);

    return {
      success: true,
      filename: opusFilename,
      engine: useYue ? 'YuE2 3B (BF16)' : 'ACE-Step 1.5',
      refAudioName: refAudioName || 'None (Unconditioned)',
      refAudioMarkdown,
      abcScore: state.abcScore || '',
      abcFilename: state.abcFilename || '',
      midiFilename: state.midiFilename || '',
      trioAbcFilename: state.trioAbcFilename || '',
      trioAbcScore: state.trioAbcScore || '',
      markdown: `\n<p><audio class="soundtrack-audio" controls src="/images/${opusFilename}"></audio></p>\n`
    };
  } catch (e) {
    console.error(`❌ Song worker (${scriptName}) failed: ${e.message}`);
    return { success: false, markdown: '', refAudioMarkdown: '' };
  } finally {
    await safeUnlink(stateFile);
  }
}

function buildScoreEmbed(audioRes) {
  if (!audioRes || !audioRes.abcScore) return '';
  const uniqueId = `score_${Date.now()}`;
  return `
---

### Compositional Score & Interactive Notation

<div class="score-controls" style="margin-bottom: 0.75rem; display: flex; gap: 12px; flex-wrap: wrap; align-items: center;">
  ${audioRes.midiFilename ? `<a class="download-btn" href="/images/${audioRes.midiFilename}" download style="padding: 6px 14px; background: #24292e; color: #58a6ff; border: 1px solid #30363d; border-radius: 6px; text-decoration: none; font-size: 0.9em; font-weight: 500;">🎹 Download MIDI (.mid)</a>` : ''}
  ${audioRes.abcFilename ? `<a class="download-btn" href="/images/${audioRes.abcFilename}" download style="padding: 6px 14px; background: #24292e; color: #58a6ff; border: 1px solid #30363d; border-radius: 6px; text-decoration: none; font-size: 0.9em; font-weight: 500;">🎼 Download Lead Score (.abc)</a>` : ''}
  ${audioRes.trioAbcFilename ? `<a class="download-btn" href="/images/${audioRes.trioAbcFilename}" download style="padding: 6px 14px; background: #24292e; color: #58a6ff; border: 1px solid #30363d; border-radius: 6px; text-decoration: none; font-size: 0.9em; font-weight: 500;">📜 Download Trio Score (.abc)</a>` : ''}
  <span style="font-size: 0.8em; opacity: 0.65; margin-left: auto;">💡 Click top score to scrub audio</span>
</div>

<div class="score-viewport-frame" style="position: relative; max-height: 580px; overflow-y: auto; overflow-x: hidden; border: 1px solid #30363d; border-radius: 8px; background: #ffffff; scroll-behavior: smooth;">
  <div class="score-playhead-tracker" style="position: absolute; left: 0; right: 0; height: 3px; background: #e63946; box-shadow: 0 0 10px #e63946, 0 0 3px #ffffff; z-index: 100; pointer-events: none; display: none; transform: translateY(-50%);"></div>
  <div class="abc-score-sheet" id="sheet-${uniqueId}" data-abc="${encodeURIComponent(audioRes.abcScore)}" style="background: #ffffff; color: #000000; padding: 16px; box-sizing: border-box; width: 100%; cursor: pointer;"></div>
</div>
`;
}

// =========================================================================
// RECURSIVE DIRECTORY SCANNER & IN-PLACE MARKDOWN UPDATER
// =========================================================================
async function findMarkdownFiles(dir) {
  let results = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(await findMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

async function main() {
  await Promise.all([
    fs.mkdir(POSTS_DIR, { recursive: true }),
    fs.mkdir(IMAGES_DIR, { recursive: true })
  ]);

  const mdFiles = await findMarkdownFiles(targetScanDir);
  console.log(`🔍 Scanned ${targetScanDir}: found ${mdFiles.length} total .md files.`);

  let voiceIdx = 0;
  let enrichedCount = 0;

  for (const filePath of mdFiles) {
    const rawMd = await fs.readFile(filePath, 'utf8');
    const parsed = parseBalladMarkdown(rawMd);

    if (!parsed) continue;
    if (parsed.alreadyEnriched && !forceReprocess) {
      console.log(`⏭️  Skipping already-enriched ballad: ${path.basename(filePath)}`);
      continue;
    }

    const slug = slugify(parsed.title);
    const assignedVoice = VOICE_CYCLE[voiceIdx % VOICE_CYCLE.length];
    voiceIdx++;

    console.log(`\n======================================================================`);
    console.log(`🎭 [BALLAD PIPELINE] Enriching: ${parsed.title}`);
    console.log(`   📂 File: ${path.relative(process.cwd(), filePath)}`);
    console.log(`======================================================================`);

    // 1. Generate Cover Art Image
    const imgRes = await runImageGen(parsed.coverArtPrompt, slug);
    if (!useGeminiImage) await freeComfyVRAM();

    // 2. Optional LTX-Video Keyframe Animation
    let vidRes = { success: false, filename: '', markdown: '' };
    if (useVideo) {
      vidRes = await runVideoGen(parsed.coverArtPrompt, imgRes.filename);
      await freeComfyVRAM();
    }

    // 3. Spoken Ballad Recitation via Kokoro TTS
    let ttsRes = { success: false, filename: '', markdown: '' };
    if (!skipTTS && parsed.poemText) {
      ttsRes = await runPoetryTTS(parsed.poemText);
      await freeComfyVRAM();
    }

    // 4. Song Realization via ACE-Step 1.5 or YuE2
    let audioRes = { success: false, filename: '', markdown: '', refAudioMarkdown: '' };
    const safeTags = sanitizeTagsForAceStep(parsed.styleTags, assignedVoice);
    if (!skipSong && parsed.structuredLyrics) {
      const activeRef = await resolveReferenceAudio(refAudioSetting);
      audioRes = await runSongWorker(
        safeTags,
        parsed.structuredLyrics,
        slug,
        generationDuration,
        activeRef
      );
      await freeComfyVRAM();
    }

    // 5. Update YAML Front Matter (add image, video, pubDate, media_enriched)
    let updatedFm = parsed.frontMatterRaw
      .split('\n')
      .filter(l => !/^(image|video|media_enriched):/.test(l.trim()));

    if (!updatedFm.some(l => l.startsWith('pubDate:'))) {
      const dateMatch = parsed.frontMatterRaw.match(/^date:\s*"([^"]+)"/m);
      const isoDate = dateMatch ? dateMatch[1].split('T')[0] : new Date().toISOString().split('T')[0];
      updatedFm.push(`pubDate: "${isoDate}"`);
    }
    if (imgRes.success) updatedFm.push(`image: "/images/${imgRes.filename}"`);
    if (vidRes.success) updatedFm.push(`video: "/images/${vidRes.filename}"`);
    updatedFm.push(`media_enriched: true`);

    // 6. Inject Generated Media Blocks into the Markdown Body
    let updatedBody = parsed.body.trim();

    // Ensure score-renderer.js and chroma-drift.js are loaded if YuE2 score exists
    const scriptsHeader = `<script src="/chroma-drift.js" type="module"></script>\n<script src="/score-renderer.js" type="module"></script>\n\n`;
    if (!updatedBody.includes('/score-renderer.js')) {
      updatedBody = scriptsHeader + updatedBody;
    }

    // Insert Cover Art + Spoken TTS audio right after the ballad stanzas (before first ---)
    const firstHrIdx = updatedBody.indexOf('\n---');
    const heroAndTtsBlock = [
      ttsRes.markdown ? `\n### Spoken Ballad Recitation (Kokoro TTS)\n${ttsRes.markdown}` : '',
      imgRes.markdown ? `\n### Visual Anchor Representation (${imgRes.engine})\n${imgRes.markdown}` : '',
      vidRes.markdown ? `\n### Kinetic Dynamic Video (${vidRes.engine})\n${vidRes.markdown}` : ''
    ]
      .filter(Boolean)
      .join('\n');

    if (firstHrIdx !== -1 && heroAndTtsBlock) {
      updatedBody =
        updatedBody.slice(0, firstHrIdx) +
        '\n' +
        heroAndTtsBlock +
        '\n' +
        updatedBody.slice(firstHrIdx);
    }

    // Append Generated Musical Score at the bottom of the Song Generator Staging section
    if (audioRes.success) {
      const scoreEmbed = buildScoreEmbed(audioRes);
      updatedBody += `\n\n---\n\n## Generated Musical Score (${audioRes.engine})\n${audioRes.markdown}\n${audioRes.refAudioMarkdown || ''}\n<blockquote><strong>Sanitized Worker Tags:</strong> <code>${safeTags}</code></blockquote>\n${scoreEmbed}\n`;
    }

    const finalMarkdown = `---\n${updatedFm.join('\n')}\n---\n\n${updatedBody}\n`;
    await fs.writeFile(filePath, finalMarkdown, 'utf8');

    enrichedCount++;
    console.log(`✅ Updated in-place with embedded media: ${path.basename(filePath)}`);
  }

  console.log(`\n🎉 Ballad pipeline complete! Enriched ${enrichedCount} ballad post(s).`);
}

main().catch(err => {
  console.error("Fatal ballad pipeline error:", err);
  process.exit(1);
});
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

const EARLY_MUSIC_REF_RE = /(tpgettys|bwv|hwv|twv|\brv\d|bach|handel|vivaldi|telemann|baroque|renaissance|early|lute|choir|aria|cantata|harpsichord|madrigal|consort|gamba|recorder|dowland|purcell|byrd|gibbons|coprario|hilton|ravenscroft|hingeston|oswald|playford|ferrabosco|loeillet)/i;
const ELECTRONIC_TAG_RE = /(synth|techno|house|electro|industrial|dubstep|trap|trance|edm|cyber|rave|phonk|glitch|ambient techno|darkwave|vapor|drum and bass|dnb|acid|breakcore|gabber|trip hop)/i;

// Reference-track matching patterns for Schema v2 (ref_style, meter, milieu, tempo_bpm)
const REF_STYLE_PATTERNS = {
  'consort-choir': /(consort[_-]?choir|choir|kbh|vocal|madrigal|motet|chorale|cantata|consort)/i,
  'aria': /(aria|solo|lute|ayre|harpsichord|sonata|dowland|handel|hwv|bwv|suite)/i,
  'consort': /(consort|fantasia|fancy|gamba|recorder|pavan|pavane|galliard|coprario|hilton|gibbons|byrd|hingeston|purcell|ferrabosco)/i
};

const TRIPLE_METER_RE = /(6[_-]?8|3[_-]?4|3[_-]?8|triple|jig|gigue|galliard|gaillard|courante|coranto|saraband|minuet|menuet|branle|siciliana|saltarello|canary|hornpipe|reel|scots|oswald|waltz)/i;
const DUPLE_METER_RE = /(4[_-]?4|2[_-]?4|duple|pavan|pavane|allemande|alman|fantasia|fancy|in[_-]?nomine|prelude|fugue|march|bourree|gavotte|ayre|air|chorale|sonata|madrigal)/i;

const MILIEU_REF_PATTERNS = {
  SCOTTISH_FLYTING: /(oswald|scots|scottish|celtic|irish|playford|ravenscroft|jig|reel|air)/i,
  AUSTRALIAN_BUSH: /(jig|reel|hornpipe|galliard|playford|ballad|dance|oswald|folk|branle)/i,
  RESTORATION_BROADSIDE: /(purcell|playford|dowland|byrd|gibbons|coprario|hilton|ravenscroft|hingeston|ferrabosco|fantasia|pavan|galliard)/i,
  MARITIME_FORECASTLE: /(hornpipe|march|jig|shanty|playford|dance|ballad|reel|branle)/i,
  FRONTIER_TALL_TALE: /(playford|dance|jig|reel|hornpipe|march|folk|ballad|oswald)/i,
  CONTEMPORARY_DRY: /(bwv|bach|scarlatti|couperin|telemann|twv|sonata|fugue|harpsichord)/i
};

const FAST_MOVEMENT_RE = /(allegro|presto|vivace|gigue|jig|galliard|gaillard|courante|coranto|hornpipe|reel|bourree|gavotte|canary|saltarello)/i;
const MODERATE_MOVEMENT_RE = /(moderato|andante|allemande|alman|minuet|menuet|air|ayre|fantasia|fancy|sonata|madrigal)/i;
const SLOW_MOVEMENT_RE = /(adagio|largo|lento|pavan|pavane|saraband|lachrimae|lament|chorale|in[_-]?nomine)/i;

const LIMERICK_GENRE_CYCLE = [
  {
    label: "Celtic Tavern Folk",
    tags: "Celtic Folk, Irish Folk, Folk, lively fiddle, acoustic guitar, bodhran, pennywhistle, 118 bpm, witty tavern limerick"
  },
  {
    label: "Baroque Harpsichord & Lute",
    tags: "Celtic Folk, Folk, Baroque lute ballad, harpsichord continuo, Renaissance lute, viola da gamba, 110 bpm, courtly wit"
  },
  {
    label: "Electro-Swing Cabaret",
    tags: "Electro-Swing, Electro-Jazz, theatrical harpsichord, upright contrabass, punchy brass, vintage swing groove, 122 bpm, playful cabaret"
  },
  {
    label: "Americana String Band",
    tags: "Americana, Bluegrass, Folk, brisk acoustic guitar, fiddle, upright bass, mandolin, 114 bpm, dry front-porch satire"
  }
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

const durArg = args.find(a => a.startsWith('--duration='));
const explicitDuration = durArg ? parseInt(durArg.split('=')[1], 10) : null;

const dirArg = args.find(a => a.startsWith('--dir='));
const targetScanDir = dirArg
  ? path.resolve(process.cwd(), dirArg.split('=')[1])
  : POSTS_DIR;

const rawRefArg = args.find(a => /^--?ref-audio(=|$)/i.test(a));
const refAudioSetting = rawRefArg
  ? (rawRefArg.includes('=') ? rawRefArg.split('=').slice(1).join('=').trim() : 'pool')
  : null;

const useKokoroCover = args.includes('--kokoro-cover');
const speechFirst = args.includes('--speech-first');
const useEarlyMusic = args.includes('--early-music');
const useRefPocket = args.includes('--ref-pocket');
const useRawAudio = args.includes('--raw-audio');
const forceRef = args.includes('--force-ref');
const noPromoteVocals = args.includes('--no-promote-vocals');
const noMidBreak = args.includes('--no-mid-break');

const introSysArg = args.find(a => a.startsWith('--intro-systems='));
const introSystemsOverride = introSysArg ? introSysArg.split('=')[1].trim() : null;

const cotArg = args.find(a => a.startsWith('--cot='));
const cotOverride = cotArg ? cotArg.split('=')[1].trim() : null;

let yueCfgOverride = null;
const yueCfgArg = args.find(a => /^--(yue-cfg|cfg)=/i.test(a));
if (yueCfgArg) {
  const parsedCfg = parseFloat(yueCfgArg.split('=')[1]);
  if (!Number.isNaN(parsedCfg)) yueCfgOverride = parsedCfg;
}

const slugify = (t) =>
  (t || 'ballad')
    .toString()
    .toLowerCase()
    .replace(/[\/_\s&]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/-{2,}/g, '-')
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

async function collectPoolAudioFiles(rootDir, maxDepth = 2, depth = 0) {
  let results = [];
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (_) {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory() && depth < maxDepth) {
      results = results.concat(await collectPoolAudioFiles(fullPath, maxDepth, depth + 1));
    } else if (entry.isFile() && /\.(opus|mp4|wav|flac|mp3)$/i.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

function scoreReferenceCandidate(relPath, hints = {}) {
  const target = (relPath || '').toLowerCase();
  let score = 0;
  const reasons = [];

  const refStyle = (hints.refStyle || '').toLowerCase();
  if (refStyle && REF_STYLE_PATTERNS[refStyle]) {
    if (REF_STYLE_PATTERNS[refStyle].test(target)) {
      score += 40;
      reasons.push(`ref_style=${refStyle}`);
    }
    // Bonus if candidate lives in a subfolder named after refStyle (e.g. ref_audio_pool/consort-choir/)
    const pathParts = target.split(/[\\/]/);
    if (pathParts.slice(0, -1).some(seg => seg.replace(/_/g, '-') === refStyle)) {
      score += 25;
      reasons.push(`folder=${refStyle}`);
    }
  }

  const meter = (hints.meter || '').trim();
  if (meter === '6/8' || meter === '3/4' || meter === '3/8') {
    if (TRIPLE_METER_RE.test(target)) {
      score += 30;
      reasons.push(`meter=${meter}(triple)`);
    } else if (DUPLE_METER_RE.test(target)) {
      score -= 8;
    }
  } else if (meter === '4/4' || meter === '2/4') {
    if (DUPLE_METER_RE.test(target)) {
      score += 24;
      reasons.push(`meter=${meter}(duple)`);
    } else if (TRIPLE_METER_RE.test(target)) {
      score -= 8;
    }
  }

  const milieu = (hints.milieu || '').toUpperCase();
  if (milieu && MILIEU_REF_PATTERNS[milieu] && MILIEU_REF_PATTERNS[milieu].test(target)) {
    score += 20;
    reasons.push(`milieu=${milieu}`);
  }

  const genreLower = (hints.musicGenre || '').toLowerCase();
  if (/baroque|harpsichord|lute/.test(genreLower) && /(bwv|bach|hwv|handel|twv|telemann|rv\d|vivaldi|lute|harpsichord|sonata|suite)/i.test(target)) {
    score += 18;
    reasons.push('genre=baroque');
  } else if (/scottish|oswald|celtic/.test(genreLower) && /(oswald|scots|celtic|irish|jig|reel|playford|ravenscroft)/i.test(target)) {
    score += 18;
    reasons.push('genre=celtic/scots');
  } else if (/consort|early english/.test(genreLower) && /(consort|fantasia|coprario|hilton|byrd|gibbons|dowland|purcell|hingeston|ferrabosco)/i.test(target)) {
    score += 18;
    reasons.push('genre=consort');
  }

  const tempoBpm = Number(hints.tempoBpm) || 0;
  if (tempoBpm > 0) {
    const bpmMatch = target.match(/(?:^|[^0-9])(\d{2,3})\s*bpm\b|\bbpm[_-]?(\d{2,3})\b/i);
    if (bpmMatch) {
      const fileBpm = parseInt(bpmMatch[1] || bpmMatch[2], 10);
      const diff = Math.abs(fileBpm - tempoBpm);
      if (diff <= 12) {
        score += 15;
        reasons.push(`bpm~${fileBpm}`);
      } else if (diff <= 24) {
        score += 8;
        reasons.push(`bpm~${fileBpm}`);
      }
    } else if (tempoBpm >= 110 && FAST_MOVEMENT_RE.test(target)) {
      score += 12;
      reasons.push(`tempo>=110(fast)`);
    } else if (tempoBpm >= 98 && tempoBpm < 110 && MODERATE_MOVEMENT_RE.test(target)) {
      score += 10;
      reasons.push(`tempo~${tempoBpm}(mod)`);
    } else if (tempoBpm < 98 && SLOW_MOVEMENT_RE.test(target)) {
      score += 12;
      reasons.push(`tempo<98(slow)`);
    }
  }

  if (hints.earlyMusicReady && EARLY_MUSIC_REF_RE.test(target)) {
    score += 5;
  }

  return { score, reasons };
}

async function resolveReferenceAudio(refArgValue, hints = null, usedRefPaths = null) {
  if (!refArgValue) return null;
  let targetPoolDir = DEFAULT_REF_POOL_DIR;

  if (refArgValue !== 'true' && refArgValue !== 'pool' && refArgValue !== 'auto') {
    try {
      const stats = await fs.stat(refArgValue);
      if (stats.isFile()) {
        console.log(`🎧 [Ref-Audio] Explicit file locked: ${path.basename(refArgValue)}`);
        return refArgValue;
      }
      if (stats.isDirectory()) targetPoolDir = refArgValue;
    } catch (_) {}
  }

  // Respect schema v2 ref_style: "none" (e.g., Electro-Swing) unless --force-ref is passed
  if (hints && (hints.refStyle || '').toLowerCase() === 'none' && !forceRef) {
    console.log(`⏭️  [Ref-Audio] Post specifies ref_style: "none" (${hints.musicGenre || 'modern'}) — running unconditioned Text-to-Music (pass --force-ref to override).`);
    return null;
  }

  const audioPaths = await collectPoolAudioFiles(targetPoolDir, 2);
  if (audioPaths.length === 0) return null;

  const hasHints = Boolean(
    hints && (hints.refStyle || hints.meter || hints.milieu || hints.tempoBpm || hints.earlyMusicReady)
  );

  if (!hasHints) {
    const unused = usedRefPaths
      ? audioPaths.filter(p => !usedRefPaths.has(p))
      : audioPaths;
    const pool = unused.length > 0 ? unused : audioPaths;
    const chosen = pool[Math.floor(Math.random() * pool.length)];
    if (usedRefPaths) usedRefPaths.add(chosen);
    return chosen;
  }

  const scored = audioPaths.map(fullPath => {
    const relPath = path.relative(targetPoolDir, fullPath);
    const { score, reasons } = scoreReferenceCandidate(relPath, hints);
    const alreadyUsedPenalty = usedRefPaths && usedRefPaths.has(fullPath) ? -25 : 0;
    return {
      fullPath,
      relPath,
      rawScore: score,
      effectiveScore: score + alreadyUsedPenalty,
      reasons
    };
  });

  scored.sort((a, b) => b.effectiveScore - a.effectiveScore);
  const bestScore = scored[0].effectiveScore;

  // Pick randomly within a narrow top-scoring tier (within 8 pts of best) so batches retain musical variety
  const topTier = scored.filter(c => c.effectiveScore >= bestScore - 8).slice(0, 5);
  const pick = topTier[Math.floor(Math.random() * topTier.length)];
  if (usedRefPaths) usedRefPaths.add(pick.fullPath);

  const reasonStr = pick.reasons.length > 0 ? pick.reasons.join(', ') : 'pool fallback';
  console.log(
    `🎧 [Ref-Audio Match] Selected "${pick.relPath}" (score=${pick.rawScore} | ${reasonStr}) from ${audioPaths.length} pool track(s).`
  );

  return pick.fullPath;
}

// =========================================================================
// MARKDOWN PARSER FOR EPISTEMIC BALLADEER (v1 & v2) & FIFTH-LINE EXPORTS
// =========================================================================
const backfillMetaOnly = args.includes('--backfill-meta');

function extractFmValue(fm, key, fallback = '') {
  const regex = new RegExp(`^${key}:\\s*"?([^"\\r\\n]+)"?`, 'm');
  const m = fm.match(regex);
  return m ? m[1].replace(/\\"/g, '"').trim() : fallback;
}

function extractFmBool(fm, key) {
  const regex = new RegExp(`^${key}:\\s*(true|false)\\b`, 'mi');
  const m = fm.match(regex);
  if (!m) return null;
  return m[1].toLowerCase() === 'true';
}

function buildSingableLimerickLyrics(poemText, title) {
  const lines = poemText
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length === 5) {
    return [
      `[Intro]`,
      ``,
      `[Verse 1]`,
      lines.join('\n'),
      ``,
      `[Chorus]`,
      lines[0],
      lines[1],
      lines[4],
      ``,
      `[Verse 2]`,
      lines.join('\n'),
      ``,
      `[Outro]`,
      lines[4]
    ].join('\n');
  }

  return `[Intro]\n\n[Verse 1]\n${poemText}\n\n[Outro]`;
}

function parseBalladMarkdown(rawMd, filePath = '', genreCycleIdx = 0) {
  const fmMatch = rawMd.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fmMatch) return null;

  const frontMatterRaw = fmMatch[1];
  const body = fmMatch[2];
  const baseName = path.basename(filePath);

  const isBallad =
    frontMatterRaw.includes('epistemic_strategy:') ||
    frontMatterRaw.includes('source: "balladeer"');
  const isFifthLine =
    frontMatterRaw.includes('source: "fifth-line"') ||
    baseName.startsWith('verse-limerick-');

  const isIndex =
    frontMatterRaw.includes('form: "INDEX"') ||
    frontMatterRaw.includes('author: "Fifth Line Archive"') ||
    baseName.startsWith('archive-index-');

  if ((!isBallad && !isFifthLine) || isIndex) return null;

  const alreadyEnriched =
    frontMatterRaw.includes('media_enriched: true') ||
    /^rendered:\s*true/m.test(frontMatterRaw) ||
    /^status:\s*"rendered"/m.test(frontMatterRaw);

  const schemaVersion = parseInt(extractFmValue(frontMatterRaw, 'schema_version', '1'), 10) || 1;

  const title = extractFmValue(
    frontMatterRaw,
    'title',
    isFifthLine ? 'Fifth Line Limerick' : 'Epistemic Ballad'
  );
  const modelUsed = extractFmValue(frontMatterRaw, 'model', 'gemini-4-hydrogen');
  const formUsed = extractFmValue(
    frontMatterRaw,
    'form',
    isFifthLine ? 'ANAPESTIC_LIMERICK' : 'BALLAD_SHORT'
  );
  const strategyUsed = extractFmValue(
    frontMatterRaw,
    'epistemic_strategy',
    isFifthLine ? 'AABBA_PROSODY' : 'AUTO'
  );

  // Schema v2 orthogonal axes & Early Music reference hints
  const milieu = extractFmValue(frontMatterRaw, 'milieu', '');
  const pov = extractFmValue(frontMatterRaw, 'pov', '');
  const foil = extractFmValue(frontMatterRaw, 'foil', '');
  const meter = extractFmValue(frontMatterRaw, 'meter', '');
  const tempoBpmRaw = extractFmValue(frontMatterRaw, 'tempo_bpm', '');
  const tempoBpm = tempoBpmRaw ? parseInt(tempoBpmRaw, 10) || null : null;
  const refStyle = extractFmValue(frontMatterRaw, 'ref_style', '');
  const earlyMusicReadyExplicit = extractFmBool(frontMatterRaw, 'early_music_ready');

  const limerickGenre = LIMERICK_GENRE_CYCLE[genreCycleIdx % LIMERICK_GENRE_CYCLE.length];
  const musicGenre = extractFmValue(
    frontMatterRaw,
    'music_genre',
    isFifthLine ? limerickGenre.label : 'Early English Consort'
  );

  const seedLine =
    extractFmValue(frontMatterRaw, 'seed_line', '') ||
    extractFmValue(frontMatterRaw, 'topic', '');
  const punchline = extractFmValue(frontMatterRaw, 'punchline', '');
  const afterHours =
    /^after_hours:\s*true/m.test(frontMatterRaw) ||
    /^afterHours:\s*true/m.test(frontMatterRaw);

  // Extract Poem Text (supports both # Title ballads and headless fifth-line limericks)
  let poemText = '';
  const beforeFirstHr = body.split(/\r?\n---\r?\n/)[0] || '';
  poemText = beforeFirstHr
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/^#\s+.*$/gm, '')
    .replace(/^>\s+.*$/gm, '')
    .replace(/^\*Punchline:[\s\S]*?\*$/gm, '')
    .trim();

  // Extract Style Tags
  let styleTags = isFifthLine
    ? limerickGenre.tags
    : 'Celtic Folk, Folk, Baroque lute ballad, Renaissance lute';
  const tagsMatch = body.match(/### Style & Instrumentation Tags\s+```(?:text)?\r?\n([\s\S]*?)```/i);
  if (tagsMatch && tagsMatch[1].trim()) {
    styleTags = tagsMatch[1].trim();
  }

  // Extract Structured Lyrics (or synthesize a Verse/Chorus structure for 5-line limericks)
  let structuredLyrics = isFifthLine
    ? buildSingableLimerickLyrics(poemText, title)
    : poemText;
  const lyricsMatch = body.match(/### Structured Lyrics\s+```(?:text)?\r?\n([\s\S]*?)```/i);
  if (lyricsMatch && lyricsMatch[1].trim()) {
    structuredLyrics = lyricsMatch[1].trim();
  }

  // Extract Cover Art / Visual Scene Prompt (checks Balladeer block, Prompt 1:, and T2I Keyframe block)
  let coverArtPrompt = `Period satirical broadside illustration for ${title}, crosshatch etching style, theatrical lighting, no text`;
  const artMatch = body.match(/### Cover Art \/ Keyframe Prompt\s+```(?:text)?\r?\n([\s\S]*?)```/i);
  const prompt1Match = body.match(/Prompt\s*1:\s*(.+)/i);
  const keyframeMatch = body.match(/### Text-to-Image Keyframe\s+```(?:text)?\r?\n([\s\S]*?)```/i);

  if (artMatch && artMatch[1].trim()) {
    coverArtPrompt = artMatch[1].trim();
  } else if (prompt1Match && prompt1Match[1].trim()) {
    coverArtPrompt = prompt1Match[1].replace(/^[*`"']+|[*`"']+$/g, '').trim();
  } else if (keyframeMatch && keyframeMatch[1].trim()) {
    coverArtPrompt = keyframeMatch[1].trim();
  }

  // Optional I2V Motion Prompt from fifth-line-gemini
  let motionPrompt = coverArtPrompt;
  const motionMatch = body.match(/### Image-to-Video Motion\s+```(?:text)?\r?\n([\s\S]*?)```/i);
  if (motionMatch && motionMatch[1].trim()) {
    motionPrompt = motionMatch[1].trim();
  }

  const hasImageEmbed = /### Visual Anchor Representation/i.test(body);
  const hasTtsEmbed = /### Spoken (?:Ballad|Limerick) Recitation/i.test(body);
  const hasSongEmbed = /## Generated Musical Score/i.test(body);

  const existingTtsMatch = body.match(
    /### Spoken (?:Ballad|Limerick) Recitation[\s\S]*?<audio[^>]+src="\/images\/([^"]+\.opus)"/i
  );
  const existingTtsFilename = existingTtsMatch ? existingTtsMatch[1] : '';

  return {
    sourceType: isFifthLine ? 'fifth-line' : 'balladeer',
    isFifthLine,
    schemaVersion,
    frontMatterRaw,
    body,
    title,
    modelUsed,
    formUsed,
    strategyUsed,
    milieu,
    pov,
    foil,
    meter,
    tempoBpm,
    refStyle,
    earlyMusicReadyExplicit,
    musicGenre,
    seedLine,
    punchline,
    afterHours,
    alreadyEnriched,
    hasImageEmbed,
    hasTtsEmbed,
    hasSongEmbed,
    existingTtsFilename,
    poemText,
    styleTags,
    structuredLyrics,
    coverArtPrompt,
    motionPrompt
  };
}

function sanitizeTagsForAceStep(rawTags, assignedVoice, earlyMusicMode = false) {
  const tokens = (rawTags || '')
    .replace(/[\[\]()]/g, '')
    .split(',')
    .map(t => t.trim())
    .filter(t => {
      if (!t) return false;
      // Strip any pre-baked vocal tags from exported markdown
      if (/baritone|tenor|soprano|mezzo|vocals|vocal|duet|male|female|instrumental/i.test(t)) return false;
      if (earlyMusicMode && (/^classical$/i.test(t) || ELECTRONIC_TAG_RE.test(t))) return false;
      return true;
    });

  const matchedAce = tokens.filter(t =>
    RAW_ACE_STYLES.some(s => s.toLowerCase() === t.toLowerCase())
  );
  let descriptive = tokens.filter(t => !matchedAce.includes(t));

  let baseGenres;
  if (earlyMusicMode) {
    // Anchor early-music blending through Celtic Folk & Folk instead of Classical
    const extraFolk = matchedAce.filter(t => !/^(celtic folk|folk)$/i.test(t));
    baseGenres = ['Celtic Folk', 'Folk', ...extraFolk].slice(0, 3);
    const hasEarlyDescriptor = descriptive.some(t =>
      /baroque|renaissance|early|lute|harpsichord|chamber|aria|cantata|madrigal|continuo|acoustic|harp|gamba|recorder|ballad/i.test(t)
    );
    if (!hasEarlyDescriptor) {
      descriptive = ['Baroque folk ballad', 'Renaissance lute', 'warm chamber strings', ...descriptive];
    }
  } else {
    baseGenres = matchedAce.length > 0 ? matchedAce.slice(0, 3) : ['Folk', 'Celtic Folk'];
  }

  return [...new Set([...baseGenres, ...descriptive.slice(0, 4), assignedVoice])].join(', ');
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
          markdown: `<p><img src="/images/${filename}" style="max-width:100%; border-radius:8px;" alt="Visual Anchor" /></p>`
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
        markdown: `<p><img src="/images/${finalFilename}" style="max-width:100%; border-radius:8px;" alt="Visual Anchor" /></p>`
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
    console.log(`🎙️ [ComfyUI TTS] Synthesizing spoken verse via run_kokoro_tts.js...`);
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
      stanzaFiles: state.stanzaFiles || [],
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

async function runSongWorker(tags, lyrics, slug, duration, referenceAudio, ttsAudioPath = null, stanzaFiles = [], earlyMusicMode = false) {
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

    if (useYue) {
      if (earlyMusicMode) runnerArgs.push('--early-music');
      if (useRefPocket) runnerArgs.push('--ref-pocket');
      if (noPromoteVocals) runnerArgs.push('--no-promote-vocals');
      if (noMidBreak) runnerArgs.push('--no-mid-break');
      if (introSystemsOverride !== null) runnerArgs.push('--intro-systems', introSystemsOverride);
      if (cotOverride) runnerArgs.push('--cot', cotOverride);
      if (yueCfgOverride !== null) runnerArgs.push('--cfg', yueCfgOverride.toString());
    }

    let refAudioName = null;
    let refAudioMarkdown = '';
    const hasTtsGuide = Boolean(useYue && useKokoroCover && ttsAudioPath && existsSync(ttsAudioPath));
    const validStanzas = (useYue && useKokoroCover) ? (stanzaFiles || []).filter(p => p && existsSync(p)) : [];

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

    // Gate Kokoro stanza/TTS interleaving strictly behind --kokoro-cover so pure musical covers sing cleanly
    if (useYue && useKokoroCover && validStanzas.length > 0 && referenceAudio) {
      console.log(`🎙️ [YuE2 Cover] --kokoro-cover enabled: interleaving ${validStanzas.length} Kokoro stanzas over ducked reference audio.`);
      runnerArgs.push('--stanza-files', JSON.stringify(validStanzas));
      if (speechFirst) {
        runnerArgs.push('--speech-first');
      }
    } else if (useYue && useKokoroCover && hasTtsGuide) {
      console.log(`🎙️ [YuE2 Cover] --kokoro-cover enabled: using pure Kokoro TTS cadence guide.`);
      runnerArgs.push('--tts-audio', ttsAudioPath);
      if (!referenceAudio) {
        refAudioName = `${path.basename(ttsAudioPath)} (Pure Kokoro Cadence Guide)`;
      }
    } else if (useYue && referenceAudio) {
      console.log(`🎶 [YuE2 Pure Musical Cover] Bypassing Kokoro interleaving (pass --kokoro-cover to enable spoken guide).`);
    }

    // spawnSync passes multi-line lyrics safely without shell quote breaking
    spawnSync('bun', runnerArgs, { stdio: 'inherit' });

    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    const rawFlacPath = state.savedFilePath;
    const actualDur = state.duration || duration;
    const modeStamp = (referenceAudio || hasTtsGuide) ? '' : 'text_to_music_';
    const opusFilename = `${prefix}_${modeStamp}${slug}_${Date.now()}.opus`;
    const opusPath = path.join(IMAGES_DIR, opusFilename);

    // Apply gentle upper-mid de-harshing & high-shelf smoothing to YuE2 output (bypass with --raw-audio)
    const outputAf = (useYue && !useRawAudio)
      ? `equalizer=f=3200:t=q:w=1.2:g=-2,highshelf=f=9000:g=-2,alimiter=limit=-1.2dB,afade=t=out:st=${Math.max(0, actualDur - 5)}:d=5`
      : `afade=t=out:st=${Math.max(0, actualDur - 5)}:d=5`;

    await execFileAsync('ffmpeg', [
      '-y', '-i', rawFlacPath,
      '-af', outputAf,
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

  const VOICE_STATE_FILE = path.join(process.cwd(), '.voice_state.json');
  let voiceIdx = 0;
  try {
    const vState = JSON.parse(await fs.readFile(VOICE_STATE_FILE, 'utf8'));
    voiceIdx = (Number(vState.lastIndex) || 0) + 1;
  } catch (_) {}

  const usedRefPaths = new Set();
  let enrichedCount = 0;

  for (const filePath of mdFiles) {
    const rawMd = await fs.readFile(filePath, 'utf8');
    const parsed = parseBalladMarkdown(rawMd, filePath, voiceIdx);

    if (!parsed) continue;
    const missingRequestedSong = !skipSong && Boolean(parsed.structuredLyrics) && !parsed.hasSongEmbed;

    if (parsed.alreadyEnriched && !missingRequestedSong && !forceReprocess && !backfillMetaOnly) {
      console.log(`⏭️  Skipping already-enriched ${parsed.sourceType} post: ${path.basename(filePath)}`);
      continue;
    }

    const slug = slugify(parsed.title);
    const assignedVoice = VOICE_CYCLE[voiceIdx % VOICE_CYCLE.length];
    await fs.writeFile(
      VOICE_STATE_FILE,
      JSON.stringify({ lastIndex: voiceIdx % VOICE_CYCLE.length }),
      'utf8'
    );
    voiceIdx++;

    const isSingleLimerick = parsed.isFifthLine || parsed.formUsed === 'LIMERICK_SINGLE';
    const refHints = {
      refStyle: parsed.refStyle,
      meter: parsed.meter,
      tempoBpm: parsed.tempoBpm,
      milieu: parsed.milieu,
      musicGenre: parsed.musicGenre,
      earlyMusicReady: parsed.earlyMusicReadyExplicit === true
    };

    const willGenerateSong = !backfillMetaOnly && !skipSong && Boolean(parsed.structuredLyrics) && (!parsed.hasSongEmbed || forceReprocess);
    const activeRef = willGenerateSong
      ? await resolveReferenceAudio(refAudioSetting, refHints, usedRefPaths)
      : null;

    // Scale default song duration: 60s for 5-line limericks,
    // 165s for unconditioned text-to-music ballads, 128s fallback for cover mode
    const defaultBalladDuration = (!activeRef && !useKokoroCover) ? 165 : 128;
    const activeDuration =
      explicitDuration || (isSingleLimerick ? 60 : defaultBalladDuration);

    console.log(`🎙️ Stateful Voice Assigned for ${isSingleLimerick ? 'Limerick' : 'Ballad'}: [${assignedVoice}]`);

    let imgRes = { success: false, filename: '', engine: 'Existing/Skipped', markdown: '' };
    let vidRes = { success: false, filename: '', engine: 'Skipped', markdown: '' };
    let ttsRes = { success: false, filename: '', engine: 'Existing/Skipped', markdown: '' };
    let audioRes = { success: false, filename: '', engine: 'Existing/Skipped', markdown: '', refAudioMarkdown: '', refAudioName: '' };

    const refLooksEarlyMusic = Boolean(activeRef && EARLY_MUSIC_REF_RE.test(path.basename(activeRef)));
    const genreLooksEarlyMusic = /baroque|renaissance|early|lute|harpsichord|madrigal|cantata|celtic|gamba|recorder|consort|oswald|scots|shanty/i.test(
      `${parsed.musicGenre} ${parsed.styleTags}`
    );

    // Strictly honor explicit Schema v2 early_music_ready: false unless CLI --early-music is forced
    const isEarlyMusicRun = useEarlyMusic
      ? true
      : parsed.earlyMusicReadyExplicit === false
      ? false
      : Boolean(useYue && (
          parsed.earlyMusicReadyExplicit === true ||
          refLooksEarlyMusic ||
          genreLooksEarlyMusic
        ));

    const safeTags = sanitizeTagsForAceStep(parsed.styleTags, assignedVoice, isEarlyMusicRun);

    if (!backfillMetaOnly) {
      console.log(`\n======================================================================`);
      console.log(`🎭 [${parsed.isFifthLine ? 'FIFTH LINE' : 'BALLAD'} PIPELINE v${parsed.schemaVersion}] Enriching: ${parsed.title} (${parsed.modelUsed})`);
      console.log(`   📂 File: ${path.relative(process.cwd(), filePath)}`);
      if (parsed.milieu || parsed.pov || parsed.foil || parsed.refStyle) {
        console.log(
          `   🧭 Axes: milieu=${parsed.milieu || 'N/A'} | pov=${parsed.pov || 'N/A'} | foil=${parsed.foil || 'N/A'} | meter=${parsed.meter || 'N/A'} | bpm=${parsed.tempoBpm || 'N/A'} | ref_style=${parsed.refStyle || 'N/A'}`
        );
      }
      console.log(`======================================================================`);

      if (!parsed.hasImageEmbed || forceReprocess) {
        imgRes = await runImageGen(parsed.coverArtPrompt, slug);
        if (!useGeminiImage) await freeComfyVRAM();
      } else {
        console.log(`⏭️  Image already embedded in ${path.basename(filePath)}, skipping Krea...`);
      }

      if (useVideo) {
        vidRes = await runVideoGen(parsed.motionPrompt || parsed.coverArtPrompt, imgRes.filename);
        await freeComfyVRAM();
      }

      if (!skipTTS && parsed.poemText && (!parsed.hasTtsEmbed || forceReprocess)) {
        ttsRes = await runPoetryTTS(parsed.poemText);
        await freeComfyVRAM();
      } else if (parsed.hasTtsEmbed) {
        console.log(`⏭️  Kokoro TTS already embedded in ${path.basename(filePath)}, skipping TTS...`);
      }

      if (willGenerateSong) {
        const ttsFile = ttsRes.filename || parsed.existingTtsFilename;
        const activeTtsPath = ttsFile ? path.join(IMAGES_DIR, ttsFile) : null;
        if (isEarlyMusicRun) {
          console.log(`🎻 [Early-Music Conditioning Active] Tags anchored in Celtic Folk / Folk: "${safeTags}"`);
        }
        audioRes = await runSongWorker(
          safeTags,
          parsed.structuredLyrics,
          slug,
          activeDuration,
          activeRef,
          activeTtsPath,
          ttsRes.stanzaFiles,
          isEarlyMusicRun
        );
        await freeComfyVRAM();
      }

      // Clean up temporary individual Kokoro stanza files after song generation
      for (const stPath of (ttsRes.stanzaFiles || [])) {
        await safeUnlink(stPath);
      }
    }

    // Build Astro-compatible tags & author front matter (including Schema v2 milieu, pov, foil, early-music, meter, ref_style)
    const meterTag = parsed.meter ? `meter-${slugify(parsed.meter)}` : '';
    const refStyleTag = parsed.refStyle && parsed.refStyle !== 'none' ? `ref-${slugify(parsed.refStyle)}` : '';
    const earlyMusicTag = (parsed.earlyMusicReadyExplicit === false && !useEarlyMusic) ? '' : ((parsed.earlyMusicReadyExplicit === true || isEarlyMusicRun) ? 'early-music' : '');
    const workTypeTag = parsed.formUsed.startsWith('LIMERICK') ? 'limerick' : 'ballad';

    const tagList = parsed.isFifthLine
      ? [
          "limerick",
          "fifth-line",
          "poetry",
          slugify(parsed.modelUsed),
          slugify(parsed.musicGenre),
          parsed.afterHours ? "after-hours" : "parlor-satire"
        ]
      : [
          "balladeer",
          workTypeTag,
          slugify(parsed.modelUsed),
          slugify(parsed.formUsed),
          slugify(parsed.strategyUsed),
          parsed.milieu ? slugify(parsed.milieu) : '',
          parsed.pov ? slugify(parsed.pov) : '',
          parsed.foil ? slugify(parsed.foil) : '',
          slugify(parsed.musicGenre),
          earlyMusicTag,
          meterTag,
          refStyleTag,
          parsed.afterHours ? "after-hours" : "parlor-satire"
        ];
    const uniqueTags = [...new Set(tagList.filter(Boolean))];

    let updatedFm = parsed.frontMatterRaw
      .split(/\r?\n/)
      .filter(l => !/^(author|domain|tags|media_enriched|rendered|status):/.test(l.trim()));

    if (!updatedFm.some(l => l.startsWith('pubDate:'))) {
      const dateMatch = parsed.frontMatterRaw.match(/^date:\s*"([^"]+)"/m);
      const isoDate = dateMatch ? dateMatch[1].split('T')[0] : new Date().toISOString().split('T')[0];
      updatedFm.push(`pubDate: "${isoDate}"`);
    }

    const authorLabel = parsed.isFifthLine
      ? `Fifth Line (${parsed.modelUsed})`
      : `Epistemic Balladeer (${parsed.modelUsed})`;

    updatedFm.push(`author: "${authorLabel}"`);
    updatedFm.push(`domain: "artistic"`);
    updatedFm.push(`tags: [${uniqueTags.map(t => `"${t}"`).join(', ')}]`);

    if (imgRes.success) {
      updatedFm = updatedFm.filter(l => !l.trim().startsWith('image:'));
      updatedFm.push(`image: "/images/${imgRes.filename}"`);
    }
    if (vidRes.success) {
      updatedFm = updatedFm.filter(l => !l.trim().startsWith('video:'));
      updatedFm.push(`video: "/images/${vidRes.filename}"`);
    }
    updatedFm.push(`rendered: true`);
    updatedFm.push(`status: "rendered"`);
    updatedFm.push(`media_enriched: true`);

    let updatedBody = parsed.body.trim();

    const scriptsHeader = `<script src="/chroma-drift.js" type="module"></script>\n<script src="/score-renderer.js" type="module"></script>\n\n`;
    if (!updatedBody.includes('/score-renderer.js')) {
      updatedBody = scriptsHeader + updatedBody;
    }

    // Inject visible Seed Premise & Model banner right below # TITLE for Balladeer posts (if not already exported by app-v2.js)
    if (!parsed.isFifthLine && !updatedBody.includes('**Seed Premise:**') && parsed.seedLine) {
      const v2Parts = [
        parsed.milieu ? `**Milieu:** \`${parsed.milieu}\`` : '',
        parsed.pov ? `**POV:** \`${parsed.pov}\`` : '',
        parsed.foil ? `**Foil:** \`${parsed.foil}\`` : '',
        parsed.meter ? `**Meter:** \`${parsed.meter}\`` : '',
        parsed.tempoBpm ? `**Tempo:** \`${parsed.tempoBpm} bpm\`` : ''
      ].filter(Boolean);
      const extraLine = v2Parts.length > 0 ? ` • ${v2Parts.join(' • ')}` : '';
      const banner = `\n> **Seed Premise:** *"${parsed.seedLine}"*  \n> **Model:** \`${parsed.modelUsed}\` • **Form:** \`${parsed.formUsed}\` • **Strategy:** \`${parsed.strategyUsed}\` • **Genre:** \`${parsed.musicGenre}\`${extraLine}\n`;
      updatedBody = updatedBody.replace(/^(#\s+[^\n]+\n+)/m, `$1${banner}\n`);
    }

    if (!backfillMetaOnly) {
      const firstHrIdx = updatedBody.indexOf('\n---');
      const workLabel = parsed.isFifthLine ? 'Limerick' : 'Ballad';
      const heroAndTtsBlock = [
        ttsRes.markdown ? `\n### Spoken ${workLabel} Recitation (Kokoro TTS)\n${ttsRes.markdown}` : '',
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
      } else if (heroAndTtsBlock) {
        updatedBody += `\n\n${heroAndTtsBlock}\n`;
      }

      if (audioRes.success) {
        // Remove any previous Generated Musical Score and Analytics footer before inserting the new one
        updatedBody = updatedBody
          .replace(/\n*---\n+## Generated Musical Score[\s\S]*$/i, '')
          .replace(/\n*---\n+<h2 id="pipeline-and-debug-analytics">[\s\S]*$/i, '')
          .trimEnd();

        const scoreEmbed = buildScoreEmbed(audioRes);
        const meterTempoMeta = [
          parsed.meter ? `Meter: ${parsed.meter}` : '',
          parsed.tempoBpm ? `Tempo: ${parsed.tempoBpm} bpm` : '',
          parsed.refStyle ? `Preferred Ref Style: ${parsed.refStyle}` : ''
        ].filter(Boolean).join(' • ');

        updatedBody += `\n\n---\n\n## Generated Musical Score (${audioRes.engine})\n${audioRes.markdown}\n${audioRes.refAudioMarkdown || ''}\n<blockquote><strong>Sanitized Worker Tags:</strong> <code>${safeTags}</code>${meterTempoMeta ? `<br><strong>Schema v2 Musical Hints:</strong> <code>${meterTempoMeta}</code>` : ''}</blockquote>\n${scoreEmbed}\n`;
      }
    }

    // Append Pipeline & Debug Analytics footer if not present
    if (!updatedBody.includes('id="pipeline-and-debug-analytics"')) {
      const v2AnalyticsLines = [
        parsed.milieu ? `<strong>Satirical Milieu:</strong> <code>${parsed.milieu}</code><br>\n` : '',
        parsed.pov ? `<strong>Point of View:</strong> <code>${parsed.pov}</code><br>\n` : '',
        parsed.foil ? `<strong>Reality-Check Foil:</strong> <code>${parsed.foil}</code><br>\n` : '',
        (parsed.meter || parsed.tempoBpm || parsed.refStyle)
          ? `<strong>Musical Hints (Meter / BPM / Ref Style):</strong> <code>${parsed.meter || 'N/A'} / ${parsed.tempoBpm || 'N/A'} bpm / ${parsed.refStyle || 'N/A'}</code><br>\n`
          : '',
        audioRes.refAudioName
          ? `<strong>Selected Reference Track:</strong> <code>${audioRes.refAudioName}</code><br>\n`
          : ''
      ].join('');

      updatedBody += `\n\n---\n\n<h2 id="pipeline-and-debug-analytics">Pipeline & Debug Analytics</h2>\n\n` +
        `<strong>Active Text Inference Core Platform:</strong> <code>${parsed.modelUsed}</code><br>\n` +
        `<strong>Poetic Architecture & Strategy:</strong> <code>${parsed.formUsed} (${parsed.strategyUsed})</code><br>\n` +
        v2AnalyticsLines +
        `<strong>Musical Genre Profile:</strong> <code>${parsed.musicGenre}</code><br>\n` +
        `<strong>Seed Premise / Topic:</strong> <code>${parsed.seedLine || 'N/A'}</code>\n`;
    }

    const finalMarkdown = `---\n${updatedFm.join('\n')}\n---\n\n${updatedBody}\n`;
    await fs.writeFile(filePath, finalMarkdown, 'utf8');

    enrichedCount++;
    console.log(`✅ Updated ${backfillMetaOnly ? 'metadata & telemetry' : 'media & telemetry'}: ${path.basename(filePath)}`);
  }

  console.log(`\n🎉 Pipeline complete! Enriched ${enrichedCount} post(s).`);
}

main().catch(err => {
  console.error("Fatal ballad pipeline error:", err);
  process.exit(1);
});

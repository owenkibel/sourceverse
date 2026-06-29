const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const { execFile } = require('child_process');
const util = require('util');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const execFileAsync = util.promisify(execFile);

const MAX_CANONICAL_HYPOTHESES = 2;   // Randomly sample up to this many human hypotheses
const MAX_AI_HYPOTHESES = 2;      // Take the most recent N AI hypotheses

// --- CONFIGURATION MAPS ---
// Change this line from 'prompts-new' to your V5 directory
const PROMPTS_DIR = path.join(__dirname, 'prompts-dramatic-v5');

// Canonical hypotheses directory (previously human-hypotheses)
const CANONICAL_HYPOTHESES_DIR = path.join(__dirname, 'canonical-hypotheses');
const CANONICAL_HYPOTHESES_FILE = path.join(__dirname, 'canonical-hypotheses.json');
const POSTS_DIR = 'posts';
const IMAGES_DIR = 'images';
const X_DIR = './x';
const PROMPT_STATE_FILE = path.join(__dirname, '.prompt_state.json');
const MODEL_PATH = 'cumulative_thread_model.json';

// --- Watchdog Directories ---
const HEART_INBOX = '/home/owen/ai-projects/heartmula/inbox';
const HEART_OUTBOX = '/home/owen/ai-projects/heartmula/outbox';

const MODEL_GROK = "grok-4.3";
const MAX_CHARS_GEMINI = 1900000;
const MAX_CHARS_GROK = 35000;

// --- ACE-STEP VALID STYLES ---
const RAW_ACE_STYLES = [
  "Acid House", "Acid Techno", "Afro House", "Afro Tech", "Afrobesats", "Alternative / Indie", "Alternative Rock", "Amapiano", "Ambient", "Ambient Techno", "Americana", "Andean Music", "Arrocha", "Axe", "Bachata", "Banda Music", "Bass House", "Bassline", "Big Room", "Bluegrass", "Blues", "Bolero", "Bossa Nova", "Bounce", "Brazilian Bass", "Brazilian Popular Music", "Breakbeat", "Breakcore", "Brega", "Brega Funk", "Brega Funk (Recife)", "Brostep", "Celtic Folk", "Children", "Chillhop", "Chillstep", "Chillwave", "Choro", "City Pop", "Classical", "Coldwave", "Corridos", "Country", "Coupe Decale", "Cuarteto", "Cumbia", "Cyber-Punk", "Cyberpunk", "Dance", "Dancehall", "Dark Ambient", "Darkstep", "Darksynth", "Darkwave", "Deep House", "Dembow", "Detroit Techno", "Disco", "Downtempo", "Dream Pop", "Drill Funk", "Drone", "Drum and Bass", "Drumstep", "Dubstep", "Dubstep (Deep)", "Electro", "Electro House", "Electro-Funk", "Electro-Jazz", "Electro-Swing", "Electroacoustic", "Electroclash", "Electronic", "Electronica", "Electropop", "Emocore", "Eurobeat", "Eurodance", "Experimental", "Experimental Electronic", "Fado", "Flamenco / Bulerias", "Folk", "Forro", "Forró Eletrônico", "French House", "Funk", "Future Bass", "Future Funk", "Future Garage", "Future Rave", "Futurepop", "G-House", "Gabber", "Glitch", "Glitch Hop", "Goa Trance", "Gospel / Religious", "Gothic", "Gqom", "Grime", "Grunge", "Guarania", "Hands Up", "Hard Rock", "Hardcore", "Hardstyle", "Hardtechno", "Heavy Metal", "Highlife", "Hip Hop / Rap", "House", "Hybrid Trap", "Hyperpop", "IDM", "Indie Folk", "Industrial", "Industrial Techno", "Instrumental", "International Funk", "Irish Folk", "Italo Disco", "J-Pop / J-Rock", "Jazz", "Jersey Club", "Jovem Guarda", "Juke / Footwork", "Jungle", "K-Pop", "Kizomba", "Kuduro", "Liquid Drum and Bass", "Liquid Funk", "Lo-Fi Hip Hop", "Lofi House", "Mambo", "Marches / Anthems", "Mariachi", "Math Rock", "Melodic Techno", "Merengue", "Metal", "Micro House", "Microhouse", "Midwest Emo", "Minimal / Deep Tech", "Minimal Techno", "Moombahton", "Nativist Folk", "Neurofunk", "New Age", "New Retro Wave", "New Wave", "Nu-Funk", "Old Guard Samba", "Organic House", "Pagode", "Pagotrap", "Philly Soul", "Phonk", "Phonk House", "Piseiro", "Pop", "Pop Rock", "Post-Hardcore", "Post-Punk", "Post-Rock", "Power-Pop", "Progressive Electronic", "Progressive House", "Progressive Rock", "Psychedelia", "Psytrance", "Punk Rap / Emo Rap", "Punk Rock", "R&B", "Ragga Jungle", "Ranchera", "Rave", "Reggae", "Reggaeton", "Regional", "Retrowave", "Riddim", "Rock", "Rock and Roll", "Rockabilly", "Romantic", "Salsa", "Samba", "Samba Enredo", "Schranz", "Sertanejo", "Sertanejo Universitário", "Shoegaze", "Ska", "Soft Rock", "Soul", "Soulful House", "Surf Music", "Synthpop", "Synthwave", "Synthwave-Darkwave", "Tango", "Tech House", "Tech Trance", "Tech-Funk", "Techno", "Technopop", "Trance", "Trap", "Trip Hop", "Trova", "Turreo RKT", "UK Drill", "UK Garage", "Uplifting Trance", "Vallenato", "Vapor-Trap", "Vaporwave", "Vocal Trance", "Wave", "World Music", "Xote", "Zamba", "Zouk", "Zouk Bass"
];

const EXCLUDED_STYLES = [
  "Amapiano", "Arrocha", "Axe", "Banda Music", "Brega", "Brega Funk", "Brega Funk (Recife)", 
  "Children", "Choro", "Corridos", "Coupe Decale", "Cuarteto", "Forro", "Forró Eletrônico", 
  "Gabber", "Gospel / Religious", "Gqom", "Guarania", "Hands Up", "Jovem Guarda", "Kizomba", 
  "Kuduro", "Marches / Anthems", "Mariachi", "Nativist Folk", "Old Guard Samba", "Pagode", 
  "Pagotrap", "Piseiro", "Ranchera", "Regional", "Samba Enredo", "Schranz", "Sertanejo", 
  "Sertanejo Universitário", "Turreo RKT", "Vallenato", "Xote", "Zamba", "Zouk", "Zouk Bass"
];

// const APPROVED_STYLES_STRING = RAW_ACE_STYLES
//     .filter(style => !EXCLUDED_STYLES.includes(style))
//     .join(', ');

// REPLACE WITH THIS:
function getShuffledAceStyles() {
  const filtered = RAW_ACE_STYLES.filter(style => !EXCLUDED_STYLES.includes(style));
  
  // High-uniformity Fisher-Yates shuffle to completely break primacy bias
  for (let i = filtered.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [filtered[i], filtered[j]] = [filtered[j], filtered[i]];
  }
  
  return filtered.join(', ');
}

// --- CLI FLAGS ---
const args = process.argv.slice(2);
const useGrok = args.includes('--grok');
const forceT2V = args.includes('--t2v'); 
const useHunyuan = args.includes('--hunyuan');
const forceOmniGen = args.includes('--omnigen');
const refineWithOmniGen = args.includes('--omnigen-refine');
const useErnie = args.includes('--ernie'); 
// Inside vertical_thread6.js -> CLI FLAGS
const useLens = args.includes('--lens'); 
const useIdeogram = args.includes('--ideogram'); // <-- ADD THIS FLAG
const useHeartmula = args.includes('--heartmula');
const useOmniVoice = args.includes('--omnivoice');
const useVoxCPM2 = args.includes('--voxcpm2');

const useGeminiImage = args.includes('--gemini-image');
const useGeminiAudio = args.includes('--gemini-audio');
const useGeminiVideo = args.includes('--gemini-video');
const useGrokImagine = args.includes('--grok-imagine');

let refAudioPath = null;
const refArg = args.find(a => a.startsWith('--ref-audio='));
if (refArg) refAudioPath = refArg.split('=')[1];

let actualModelUsed = "";
let generationDuration = 128; 
const durArg = args.find(a => a.startsWith('--duration='));
if (durArg) {
  generationDuration = parseInt(durArg.split('=')[1], 10) || 128;
}

let targetThread = null;
const threadArgIndex = args.findIndex(a => a.startsWith('--thread='));
if (threadArgIndex !== -1) {
  targetThread = args[threadArgIndex].split('=')[1].trim();
}

if (useGrok && !process.env.XAI_API_KEY) throw new Error("XAI_API_KEY missing for --grok");
if (!process.env.GEMINI_API_KEY1) throw new Error("GEMINI_API_KEY1 missing");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY1);

const slugify = (t) => (t || '').toString().toLowerCase().replace(/\s+/g, '-').replace(/[^\w\-]+/g, '').replace(/^-+|-+$/g, '');

function cleanVerseText(text) {
  if (!text) return "";
  return text.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').replace(/\*\*|__|###/g, '').replace(/<[^>]*>?/gm, '').split('\n').map(line => line.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const HYPOTHESIS_COOLDOWN_ACTS = 8; // Increased from 7

function deduplicateAndFilterHypotheses(hypotheses, cumulativeModel, maxItems = 4) {
    if (!hypotheses || hypotheses.length === 0) return [];

    const seen = [];
    const result = [];

    const normalize = (text) => text.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    function jaccardSimilarity(a, b) {
        const setA = new Set(a.split(' '));
        const setB = new Set(b.split(' '));
        const intersection = new Set([...setA].filter(x => setB.has(x)));
        const union = new Set([...setA, ...setB]);
        return union.size === 0 ? 0 : intersection.size / union.size;
    }

    const recentHistory = (cumulativeModel?.predictionHistory || [])
        .slice(-25)
        .map(h => normalize(h.hypothesis || ''));

    for (const h of hypotheses) {
        if (!h.claim || h.claim.length < 25) continue;

        const norm = normalize(h.claim);

        // 1. Check against items already selected this run
        let isDuplicate = false;
        for (const existing of seen) {
            if (jaccardSimilarity(norm, existing) > 0.65) { // More aggressive
                isDuplicate = true;
                break;
            }
        }
        if (isDuplicate) continue;

        // 2. Stronger time-based cooldown
        let inCooldown = false;
        for (const recent of recentHistory) {
            if (jaccardSimilarity(norm, recent) > 0.70) {
                inCooldown = true;
                break;
            }
        }
        if (inCooldown) continue;

        // 3. Hard block on the specific repetitive claim family
        const isGatekeepingClaim = /institutional gatekeeping|ai-origin cinema|dropped project|narrative containment|de-facto veto/i.test(h.claim);
        if (isGatekeepingClaim && result.length > 0) {
            continue; // Only allow it once per run at most
        }

        seen.push(norm);
        result.push(h);

        if (result.length >= maxItems) break;
    }

    return result;
}

/**
 * Returns true only if the hypothesis claim is substantial enough to be worth storing.
 * This helps reduce repetitive/low-value entries in predictionHistory.
 */
function isStrongHypothesis(claim) {
    if (!claim || typeof claim !== 'string') return false;

    const trimmed = claim.trim();

    // Minimum length threshold (adjust as needed)
    if (trimmed.length < 120) return false;

    // Skip very generic or low-information claims
    const lower = trimmed.toLowerCase();
    if (lower.includes('no new') || lower.includes('no hypothesis')) return false;

    // Skip claims that are mostly the old repetitive pattern
    if (/institutional gatekeeping|ai-origin cinema|dropped project|narrative containment/i.test(trimmed)) {
        return false;
    }

    return true;
}

async function updateNarrativeArc(domain, newNarrativeText, parsedForecast, cumulativeModel) {
    if (!cumulativeModel.narrativeArcs[domain]) {
        cumulativeModel.narrativeArcs[domain] = {
            currentArc: "",
            lastUpdated: "",
            forecastHistory: []
        };
    }

    const arc = cumulativeModel.narrativeArcs[domain];

    // Append new prose
    const combined = (arc.currentArc + "\n\n" + newNarrativeText).trim();
    arc.currentArc = combined.length > 4500 
        ? combined.slice(-4200) 
        : combined;

    let forecastAppended = false;

    // Append forecast summary if available
    if (parsedForecast && parsedForecast.trim().length > 60) {
        const shortForecast = parsedForecast.length > 260 
            ? parsedForecast.substring(0, 257) + "..." 
            : parsedForecast;

        arc.currentArc += `\n\n[Recent Forecast Summary]: ${shortForecast}`;
        forecastAppended = true;

        console.log(`📜 Forecast summary appended to narrative arc for [${domain}]`);
    }

    arc.lastUpdated = new Date().toISOString();
    return forecastAppended; // ← Return true if we appended a forecast
}

async function freeComfyVRAM() {
    console.log("🧹 Releasing local ComfyUI VRAM nodes...");
    try {
        await fetch('http://127.0.0.1:8188/free', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ unload_models: true, free_memory: true })
        });
    } catch (e) {}
}

async function safeUnlink(filePath) {
    if (!filePath) return;
    try {
        await fs.unlink(filePath);
    } catch (e) {}
}

async function loadPrompts() {
  const files = await fs.readdir(PROMPTS_DIR);
  const available = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const p = JSON.parse(await fs.readFile(path.join(PROMPTS_DIR, file), 'utf8'));
    if (!p.system || !p.chat) continue;
    const style = p.style?.[Math.floor(Math.random() * p.style.length)] || "";
    const poet = p.poet?.[Math.floor(Math.random() * p.poet.length)] || "";
    const repl = (s) => s.replace(/\[\[style]]/g, style).replace(/\[\[poet]]/g, poet);
    available.push({ 
      name: path.basename(file, '.json'), 
      system: repl(p.system), 
      chat: repl(p.chat),
      artisticMode: p.artisticMode || "traditional"
    });
  }
  return available;
}

function parseUnifiedOutput(text) {
  const sections = { 
    verse: '', 
    forecast: '',           // ← NEW
    hypothesis: '', 
    narrative_synthesis: '',
    image: '', 
    t2v: '', 
    music: '' 
  };
  let current = 'verse';
  
  text.split('\n').forEach(line => {
    const l = line.trim().toLowerCase();
    
    if (l.match(/^(#+|\*\*|__|-)*\s*narrative synthesis/i)) {
        current = 'narrative_synthesis';
    } else if (l.match(/^(#+|\*\*|__|-)*\s*(forecast|prediction)/i)) {   // ← NEW
        current = 'forecast';
    } else if (l.match(/^(#+|\*\*|__|-)*\s*(image|visual)( generation)? prompt/i)) {
        current = 'image';
    } else if (l.match(/^(#+|\*\*|__|-)*\s*(t2v|text[- ]to[- ]video|video)( generation)? prompt/i)) {
        current = 't2v';
    } else if (l.match(/^(#+|\*\*|__|-)*\s*(music|audio|song|soundtrack)( generation)? prompt/i)) {
        current = 'music';
    } else if (l.match(/^(#+|\*\*|__|-)*\s*hypothesis/i)) {
        current = 'hypothesis';
    } else if (l.match(/^(#+|\*\*|__|-)*\s*(verse|poem|poetry|spoken text|reading|dramatic verse)/i)) {
        current = 'verse';
    } else if (sections[current] !== undefined) {
        sections[current] += line + '\n';
    }
  });

  // Clean verse
  const verse = cleanVerseText(sections.verse);

  // Clean forecast (new)
  const forecast = sections.forecast
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/```/g, '')
    .replace(/\*\*|__|###/g, '')
    .trim();

  // Clean hypothesis
  const hypothesis = sections.hypothesis
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/```/g, '')
    .replace(/\*\*|__|###/g, '')
    .trim();

  // Music parsing (unchanged)
  let rawMusic = sections.music.trim().replace(/```[a-z]*\n?/gi, '').replace(/```/g, '');
  let tags = "Electronic, rich synths, melodic pulse";
  let duration = "128"; 
  let lyrics = "";
  
  const lyricsSplit = rawMusic.split(/[*_#`]*LYRICS:[*_#`]*/i);
  let metaText = lyricsSplit.length > 1 ? lyricsSplit[0] : rawMusic;
  lyrics = lyricsSplit.length > 1 ? lyricsSplit.slice(1).join('LYRICS:').trim() : rawMusic;

  const tagMatch = metaText.match(/TAGS:\s*([^\n]+)/i);
  if (tagMatch) {
      let rawTags = tagMatch[1].replace(/[*_`#]/g, '').trim();
      let tagArray = rawTags.split(',').map(t => t.trim()).filter(t => t.length > 0);
      if (tagArray.length > 0) tags = tagArray.join(', ');
  }

  const durMatch = metaText.match(/DURATION:\s*(\d+)/i);
  if (durMatch) duration = durMatch[1].trim();

  return {
    verse: verse,
    forecast: forecast,                    // ← NEW
    hypothesis: hypothesis,
    narrative_synthesis: sections.narrative_synthesis.trim(),
    image: sections.image.trim(),
    t2v: sections.t2v.trim(), 
    musicTags: tags,
    musicDuration: duration,
    musicLyrics: lyrics.trim()
  };
}

async function generateText(system, user) {
  const maxChars = useGrok ? MAX_CHARS_GROK : MAX_CHARS_GEMINI;
  const truncatedUser = user.length > maxChars ? user.substring(0, maxChars) + '\n\n[Input Truncated]' : user;

  if (useGrok) {
    console.log(`Generating with Grok (${MODEL_GROK})...`);
    const payload = {
      model: MODEL_GROK,
      messages: [{ role: "system", content: system }, { role: "user", content: truncatedUser }],
      temperature: 1.0,
      providerOptions: { xai: { reasoningEffort: "none" } }
    };
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.XAI_API_KEY}` },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`Grok API Error: ${await res.text()}`);
    const data = await res.json();
    actualModelUsed = MODEL_GROK;
    return data.choices[0]?.message?.content || '';
  } else {
    console.log("Generating with Gemini...");
    for (const modelName of ["gemini-3.1-pro-preview", "gemini-3-flash-preview"]) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName, generationConfig: { temperature: 1 } });
        const res = await model.generateContent(`${system}\n\n${truncatedUser}`);
        actualModelUsed = modelName;
        return res.response.text();
      } catch (e) {
        console.warn(`   ⚠️ Fallback triggered: checking downstream models.`);
      }
    }
  }
  throw new Error("All text generation layers failed.");
}

// ==========================================
// --- MEDIA CORES GENERATION ARTIFACTS ---
// ==========================================
async function runGeminiImage(prompt, slug) {
   try {
        const imageModel = genAI.getGenerativeModel({ model: "gemini-3.1-flash-image-preview" });
        const verticalPrompt = `${prompt || 'Abstract surreal scene'} -- This image must be generated in a vertical 9:16 aspect ratio, portrait orientation.`;
        const result = await imageModel.generateContent(verticalPrompt);
        const imagePart = (result?.response?.candidates?.[0]?.content?.parts || []).find(p => p.inlineData);
        if (imagePart) {
            const finalFilename = `gemini_img_${slug}_${Date.now()}.png`;
            await fs.writeFile(path.join(IMAGES_DIR, finalFilename), Buffer.from(imagePart.inlineData.data, 'base64'));
            return { success: true, filename: finalFilename, engine: "Gemini 3.1 Flash Image", markdown: `<p><img src="/images/${finalFilename}" style="max-width:100%; border-radius:8px;" alt="Gemini Generated Image" /></p>` };
        }
    } catch (e) { console.error(`❌ Gemini Image engine failure: ${e.message}`); }
    return { success: false, markdown: '' };
}

async function runGeminiVideo(prompt, slug) {
    const API_KEY = process.env.GEMINI_API_KEY1;
    try {
        const startResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning?key=${API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ "instances": [{ "prompt": prompt || "Cinematic wide shot" }], "parameters": { "aspectRatio": "9:16" } })
        });
        const startData = await startResponse.json();
        if (startData.error) throw new Error(startData.error.message);
        
        let isDone = false;
        let pollData;
        while (!isDone) {
            await new Promise(r => setTimeout(r, 10000));
            const pollResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/${startData.name}?key=${API_KEY}`);
            pollData = await pollResponse.json();
            if (pollData.done) isDone = true;
        }
        const videoUri = pollData.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
        if (videoUri) {
            const videoResponse = await fetch(videoUri, { headers: { 'x-goog-api-key': API_KEY } });
            const finalFilename = `gemini_vid_${slug}_${Date.now()}.mp4`;
            await fs.writeFile(path.join(IMAGES_DIR, finalFilename), Buffer.from(await videoResponse.arrayBuffer()));
            return { success: true, filename: finalFilename, engine: "Veo 3.1 Preview", markdown: `\n<p><video controls src="/images/${finalFilename}" style="max-width: 100%; border-radius: 8px;" loop muted></video></p>\n` };
        }
    } catch (e) { console.error(`❌ Gemini Video Core Error: ${e.message}`); }
    return { success: false, markdown: '' };
}

async function runGrokImagine(imagePrompt, slug) {
  const filename = `grok_imagine_${slug}_${Date.now()}.jpg`;
  try {
    const response = await fetch('https://api.x.ai/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.XAI_API_KEY}` },
      body: JSON.stringify({ model: "grok-imagine-image", prompt: `${imagePrompt} --ar 9:16 --style raw`, n: 1 })
    });
    const data = await response.json();
    const imageUrl = data.data?.[0]?.url;
    if (imageUrl) {
      const imgRes = await fetch(imageUrl);
      await fs.writeFile(path.join(IMAGES_DIR, filename), Buffer.from(await imgRes.arrayBuffer()));
      return { success: true, filename, engine: "Grok Imagine", markdown: `<p><img src="/images/${filename}" style="max-width:100%; border-radius:8px;" /></p>` };
    }
  } catch (e) { console.error(`❌ Grok Imagine framework error: ${e.message}`); }
  return { success: false, markdown: '' };
}

async function runImageGen(prompt) {
  const stateFile = path.join(os.tmpdir(), `state-${Date.now()}.json`);
  try {
    await fs.writeFile('prompt.txt', prompt || 'Abstract composition', 'utf8');
    
    // Route to run_ideogram.js when the command line flag is active
    let runnerArgs = refineWithOmniGen ? ['run_omnigen_i2i.js'] : 
                     (forceOmniGen ? ['run_omnigen_t2i.js'] : 
                     (useErnie ? ['run_ernie.js'] : 
                     (useLens ? ['run_lens.js'] : 
                     (useIdeogram ? ['run_ideogram.js'] : ['run_z_turbo.js']))));
    
    if (refineWithOmniGen) {
        await execFileAsync('bun', ['run_z_turbo.js', '--state-file', 'anchor_state.json']);
    }
    
    await execFileAsync('bun', [...runnerArgs, '--state-file', stateFile]);
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    const finalFilename = state.filename;

    return { 
      success: true, 
      filename: finalFilename, 
      engine: runnerArgs[0] === 'run_lens.js' ? 'Lens' : (runnerArgs[0] === 'run_ideogram.js' ? 'Ideogram 4' : (runnerArgs[0] === 'run_z_turbo.js' ? 'Z-Turbo' : 'OmniGen2')), 
      markdown: `<p><img src="/images/${finalFilename}" style="max-width:100%; border-radius:8px;" alt="Visual Artifact" /></p>` 
    };
  } catch (e) { 
    console.error(`Local Image asset tracking worker failed: ${e.message}`); 
    return { success: false, markdown: '' }; 
  } finally { 
    await safeUnlink(stateFile); 
    await safeUnlink('prompt.txt'); 
  }
}

async function runVideoGen(videoPrompt, anchorImageName, isT2V) {
  const stateFile = path.join(os.tmpdir(), `vid-state-${Date.now()}.json`);
  try {
    let runnerArgs = useHunyuan ? ['run_fasthunyuan_t2v.js', '--state-file', stateFile, '--prompt', videoPrompt] : ['run_ltx_video.js', '--state-file', stateFile, '--prompt', videoPrompt];
    if (!useHunyuan) {
        if (isT2V) runnerArgs.push('--t2v');
        else if (anchorImageName) runnerArgs.push('--image', anchorImageName);
    }
    await execFileAsync('bun', runnerArgs);
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    const filename = state.filename || path.basename(state.savedFilePath);
    return { success: true, filename: filename, engine: useHunyuan ? "Hunyuan" : "LTX-Video", markdown: `\n<p><video controls src="/images/${filename}" style="max-width:100%; border-radius:8px;" loop muted></video></p>\n` };
  } catch (e) { console.error(`Video generation worker failed: ${e.message}`); return { success: false, markdown: '' }; }
  finally { await safeUnlink(stateFile); }
}

async function runPoetryTTS(poemText) {
    const stateFile = path.join(os.tmpdir(), `tts-state-${Date.now()}.json`);
    const poemFile = 'temp_poem.txt';
    try {
        await fs.writeFile(poemFile, poemText || 'Silence.', 'utf8');
        let runnerArgs = useOmniVoice ? ['run_omnivoice_clone.js'] : (useVoxCPM2 ? ['run_voxcpm2.js'] : ['run_kokoro_tts.js']);
        await execFileAsync('bun', [...runnerArgs, '--state-file', stateFile, '--prompt-file', poemFile]);
        const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
        
        const rawFlacPath = state.savedFilePath;
        const finalOpusFilename = state.filename.replace(/\.(flac|wav)$/, '.opus');
        const finalOpusPath = path.join(IMAGES_DIR, finalOpusFilename);

        // await execFileAsync('ffmpeg', ['-y', '-i', rawFlacPath, '-c:a', 'libopus', '-b:a', '128k', finalOpusPath]);

         console.log(`   🎵 Applying Spatial Field and Opus compression...`);
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
        
        await safeUnlink(rawFlacPath);
        return { success: true, filename: finalOpusFilename, engine: runnerArgs[0] === 'run_kokoro_tts.js' ? 'Kokoro' : 'Multi-Speaker Voice Clone', markdown: `\n<p><audio controls src="/images/${finalOpusFilename}"></audio></p>\n` };
    } catch (e) { console.error(`TTS synthesis failed: ${e.message}`); return { success: false, markdown: '' }; }
    finally { await safeUnlink(stateFile); await safeUnlink(poemFile); }
}

async function runAceStepGen(tags, lyrics, slug, duration) {
    const stateFile = path.join(os.tmpdir(), `acestep-state-${Date.now()}.json`);
    try {
        console.log(`\n======================================================`);
        console.log(`🎼 [DEBUG] SUBMITTING CONTENT TO ACE-STEP PIPELINE:`);
        console.log(`   -> Target Tags:     "${tags}"`);
        console.log(`   -> Core Duration:   ${duration} seconds`);
        console.log(`   -> Engine Payload Lyrical Script:\n`);
        console.log(lyrics);
        console.log(`======================================================\n`);

        await execFileAsync('bun', ['run_acestep.js', '--state-file', stateFile, '--tags', tags, '--lyrics', lyrics, '--duration', duration.toString()]);
        const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
        const rawFlacPath = state.savedFilePath;
        const opusFilename = `acestep_${slug}_${Date.now()}.opus`;
        const opusPath = path.join(IMAGES_DIR, opusFilename);

        await execFileAsync('ffmpeg', ['-y', '-i', rawFlacPath, '-af', `afade=t=out:st=${Math.max(0, duration - 5)}:d=5`, '-c:a', 'libopus', '-b:a', '128k', opusPath]);
        
        await safeUnlink(rawFlacPath);
        return { success: true, filename: opusFilename, engine: "ACE-Step 1.5", markdown: `\n<p><audio controls src="/images/${opusFilename}"></audio></p>\n` };
    } catch (e) { console.error(`ACE-Step pipeline execution failed: ${e.message}`); return { success: false, markdown: '' }; }
    finally { await safeUnlink(stateFile); }
}

async function runAudioGen(tags, lyrics, slug, duration) {
    const baseName = `hm_${slug}_${Date.now()}`;
    const txtFile = path.join(HEART_INBOX, `${baseName}.txt`);
    const wavFile = path.join(HEART_OUTBOX, `${baseName}.wav`);
    const opusFile = path.join(IMAGES_DIR, `${baseName}.opus`);
    try {
        await fs.writeFile(txtFile, `TAGS: ${tags}\nDURATION: ${duration}\n\n${lyrics}`);
        let attempts = 0;
        while (attempts < 60) {
            await new Promise(r => setTimeout(r, 2000));
            const stats = await fs.stat(wavFile).catch(() => null);
            if (stats && stats.size > 1000) {
                await execFileAsync('ffmpeg', ['-y', '-i', wavFile, '-af', `afade=t=out:st=${Math.max(0, duration - 5)}:d=5`, '-c:a', 'libopus', '-b:a', '128k', opusFile]);
                await safeUnlink(wavFile);
                return { success: true, filename: path.basename(opusFile), engine: "Heartmula", markdown: `\n<p><audio controls src="/images/${path.basename(opusFile)}"></audio></p>\n` };
            }
            attempts++;
        }
    } catch (e) { console.error(`Watchdog pipeline error: ${e.message}`); }
  return { success: false, markdown: '' };
}

// ==========================================
// --- MEMORY MAP LIFECYCLES ---
// ==========================================

async function updateUnifiedDomainModel(domain, nextActNumber, folder, parsedOutput, activeHypotheses) {
    let model = { dramaticPlays: {}, predictionHistory: [], narrativeArcs: {} };

    try {
        const existing = await fs.readFile(MODEL_PATH, 'utf8');
        model = JSON.parse(existing);
    } catch (e) {}

    // Defensive initialization
    if (!model.dramaticPlays) model.dramaticPlays = {};
    if (!model.predictionHistory) model.predictionHistory = [];
    if (!model.narrativeArcs) model.narrativeArcs = {};
 if (!model.narrativeArcs[domain]) {
    model.narrativeArcs[domain] = {
        currentArc: "",
        lastUpdated: "",
        forecastHistory: []
    };
}

    // Existing dramaticPlays logic (unchanged)
    if (!model.dramaticPlays[domain]) model.dramaticPlays[domain] = [];

    model.dramaticPlays[domain].push({
        thread: folder,
        act: nextActNumber,
        timestamp: new Date().toISOString(),
        chorusSnapshot: parsedOutput.chorus || parsedOutput.refrain || "",
        activeHypothesesSnapshot: (activeHypotheses || []).map(h => ({
            source: h.source,
            id: h.id || "exploratory",
            summary: h.claim ? h.claim.substring(0, 120) : ""
        }))
    });

    // Store hypothesis in predictionHistory (existing logic)
    const prospectiveHypothesis = parsedOutput.hypothesis_elaboration_ai || parsedOutput.hypothesis;
    if (prospectiveHypothesis && isStrongHypothesis(prospectiveHypothesis)) {
        model.predictionHistory.push({
            timestamp: new Date().toISOString(),
            actRef: nextActNumber,
            domain: domain,
            hypothesis: prospectiveHypothesis.trim()
        });
    }

    // === NEW: Store forecast in narrativeArcs ===
    if (parsedOutput.forecast && parsedOutput.forecast.trim().length > 40) {
        const arc = model.narrativeArcs[domain];

        if (!arc.forecastHistory) arc.forecastHistory = [];

        arc.forecastHistory.push({
            act: nextActNumber,
            timestamp: new Date().toISOString(),
            forecast: parsedOutput.forecast.trim()
        });

        // Keep only the last 6 forecasts per domain to avoid bloat
        if (arc.forecastHistory.length > 6) {
            arc.forecastHistory = arc.forecastHistory.slice(-6);
        }
    }

    await fs.writeFile(MODEL_PATH, JSON.stringify(model, null, 2), 'utf8');
    console.log(`💾 Ledger state tracking committed to ${MODEL_PATH}`);
}
/**
 * Asynchronously loads canonical hypotheses and merges them with historic AI claims.
 * Preserves downstream execution tracking without pausing the pipeline node.
 */
async function loadAndMergeHypotheses(domain, cumulativeModel, isTraditional = false) {
    let canonicalHyps = [];
    const HYPOTHESES_DIR = path.join(__dirname, 'canonical-hypotheses');   // ← Updated directory name

    try {
        const files = await fs.readdir(HYPOTHESES_DIR);
        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            const content = JSON.parse(await fs.readFile(path.join(HYPOTHESES_DIR, file), 'utf8'));
            if (content.hypotheses) canonicalHyps.push(...content.hypotheses);
        }
    } catch (e) {
        try {
            // Fallback to single file if directory doesn't exist
            const unified = JSON.parse(await fs.readFile(
                path.join(__dirname, 'canonical-hypotheses.json'), 'utf8'   // ← Updated fallback
            ));
            if (unified.hypotheses) canonicalHyps = unified.hypotheses;
        } catch (_) {}
    }

    const domainLower = (domain || '').toLowerCase();
    let filteredCanonical = canonicalHyps.filter(h =>
        (h.domain || '').toLowerCase() === domainLower ||
        (h.domain || '').toLowerCase() === 'general'
    );

    // === Mode-aware selection ===
    let selectedCanonical = filteredCanonical;   // ← renamed
    let selectedAI = [];

    if (isTraditional) {
        // Traditional mode: keep only canonical + at most 1 recent AI
        selectedCanonical = filteredCanonical.slice(0, MAX_CANONICAL_HYPOTHESES);
        if (cumulativeModel?.predictionHistory) {
            const recent = cumulativeModel.predictionHistory
                .filter(entry => entry.hypothesis && entry.hypothesis.length > 25)
                .slice(-1);
            selectedAI = recent.map(entry => ({
                id: entry.id || `ai-${Date.now()}`,
                claim: entry.hypothesis,
                source: "ai"
            }));
        }
    } else {
        // Dramatic mode: random sample canonical + recent AI with deduplication
        if (filteredCanonical.length > MAX_CANONICAL_HYPOTHESES) {
            selectedCanonical = filteredCanonical
                .map(h => ({ h, sort: Math.random() }))
                .sort((a, b) => a.sort - b.sort)
                .slice(0, MAX_CANONICAL_HYPOTHESES)
                .map(item => item.h);
        }

        if (cumulativeModel?.predictionHistory) {
            const recentAI = cumulativeModel.predictionHistory
                .filter(entry => entry.hypothesis && entry.hypothesis.length > 25)
                .slice(-MAX_AI_HYPOTHESES);

            const aiCandidates = recentAI.map(entry => ({
                id: entry.id || `ai-${Date.now()}`,
                claim: entry.hypothesis,
                source: "ai"
            }));

            selectedAI = deduplicateAndFilterHypotheses(aiCandidates, cumulativeModel, MAX_AI_HYPOTHESES);
        }
    }

    const merged = [
        ...selectedCanonical.map(h => ({ ...h, source: "canonical" })),   // ← changed source
        ...selectedAI
    ];

    return merged;
}

async function buildNarrativeContext(domain, cumulativeModel) {
    if (!cumulativeModel.narrativeArcs || !cumulativeModel.narrativeArcs[domain]) {
        return { context: "This is the beginning of the narrative arc for this domain.", injected: 0 };
    }

    const arc = cumulativeModel.narrativeArcs[domain];
    let context = `PREVIOUS STORY ARC:\n${arc.currentArc || ''}\n\n`;
    let injectedCount = 0;

    // Inject recent hypotheses as story seeds
    const seeds = (cumulativeModel.predictionHistory || [])
        .filter(h => h.domain === domain)
        .slice(-2);

    if (seeds.length > 0) {
        context += "KEY THEMES AND FORCES TO WEAVE INTO THE STORY:\n";
        seeds.forEach((h, i) => {
            context += `${i + 1}. ${h.hypothesis.substring(0, 320)}...\n`;
        });
    }

    // === Inject recent forecasts for continuity ===
    if (arc.forecastHistory && arc.forecastHistory.length > 0) {
        const recentForecasts = arc.forecastHistory.slice(-2);

        context += "\nRECENT FORECASTS (for continuity, last 2 acts):\n";
        recentForecasts.forEach((f, i) => {
            const shortForecast = f.forecast.length > 220 
                ? f.forecast.substring(0, 217) + "..." 
                : f.forecast;
            context += `${i + 1}. (Act ${f.act}) ${shortForecast}\n`;
        });

        injectedCount = recentForecasts.length;

        console.log(`   📜 Injected ${injectedCount} recent forecast(s) into prompt for [${domain}]`);
    }

    return { context, injected: injectedCount };
}

async function main() {
  await Promise.all([fs.mkdir(POSTS_DIR, { recursive: true }), fs.mkdir(IMAGES_DIR, { recursive: true })]);

  // ======================================================
  // FORECAST LIFECYCLE METRICS
  // These counters track the full journey of forecasts through the pipeline:
  //
  // - forecastsProcessedThisRun : How many forecasts the model actually generated
  //                               and that were successfully parsed from the output.
  //
  // - forecastsAppendedThisRun  : How many of those forecasts were substantial enough
  //                               to be appended to the persistent narrative arc
  //                               (stored in cumulative_thread_model.json).
  //
  // - forecastsInjectedThisRun  : How many forecasts were pulled from the narrative arc
  //                               and injected into the prompt context for future runs
  //                               (via buildNarrativeContext). This measures continuity.
  //
  // These metrics help monitor forecast quality, storage behavior, and long-term
  // narrative memory across multiple pipeline executions.
  // ======================================================
  let forecastsProcessedThisRun = 0;
  let forecastsAppendedThisRun = 0;
  let forecastsInjectedThisRun = 0;

  const prompts = await loadPrompts();
  if (prompts.length === 0) throw new Error("No files discovered inside prompts-dramatic-v5 directory.");

  // Prompt cycling
  let promptIndex = 0;
  try {
    const stateData = JSON.parse(await fs.readFile(PROMPT_STATE_FILE, 'utf8'));
    promptIndex = (Number(stateData.lastIndex) || 0) + 1;
  } catch (e) {}
  if (promptIndex >= prompts.length || isNaN(promptIndex)) promptIndex = 0;

  const selPrompt = prompts[promptIndex];
  await fs.writeFile(PROMPT_STATE_FILE, JSON.stringify({ lastIndex: promptIndex }));

  const isTraditional = selPrompt.artisticMode === "traditional";
  console.log(`\n📄 Active contextual prompt style: ${selPrompt.name} [Artistic Mode: ${selPrompt.artisticMode}]`);

  const allFolders = await fs.readdir(X_DIR);
  const threadFolders = allFolders.filter(f => /^t\d+$/.test(f)).sort();
  const toProcess = targetThread ? threadFolders.filter(f => f === targetThread) : threadFolders;

  for (const folder of toProcess) {
    console.log(`\n--- Production Layer Execution Node: ${folder} ---`);

    let payload;
    try {
      payload = JSON.parse(await fs.readFile(path.join(X_DIR, folder, 'payload.json'), 'utf8'));
    } catch (e) {
      continue;
    }

const title = payload.title || folder.toUpperCase();
const originalThematicPoem = payload.grok_poem || '';   // ← ADD THIS

    // Build rich context
    let richContextBlock = `THEMATIC SUMMARY:\n${payload.grok_poem || ''}\n\nRAW SOURCES TO TRANSMUTE:\n`;
    (payload.sources || []).forEach((src, idx) => {
      richContextBlock += `\n--- SOURCE ${idx + 1} ---\nURL: ${src.url}\nDATA ANALYSIS:\n${src.rich_text || src.description_short}\n`;
    });

    // === HARDENED DOMAIN DETECTION ===
    let domain = "technological";
    const cleanContextText = richContextBlock
      .replace(/alexa science space environment wildlife/gi, '')
      .replace(/sections? titles|nav-menu|sign in/gi, '');

    if (/\b(trump|election|political|politics|senate|midterm|democrat|republican|vandal|aoc|musk|elon|capitalism|capitalist|journalism|journalist|newsroom|media|scandal|huckabee|free beacon|national review|wsj|opinion)\b/i.test(cleanContextText)) {
      domain = "political";
    } else if (/\b(quantum|galaxy|science|physics|nuclear|atoms|ion|thorium|lattice|clock|cosmology)\b/i.test(cleanContextText)) {
      domain = "scientific";
    } else if (/\b(art|music|baroque|bach|harpsichord|cantata|aria|theatrical|canvas|poem|poetry|sonnet)\b/i.test(cleanContextText)) {
      domain = "artistic";
    }

    console.log(`📡 Domain Classification Segment settled: [${domain.toUpperCase()}]`);

    // === Load cumulative model with narrativeArcs support ===
    let cumulativeModel = { dramaticPlays: {}, predictionHistory: [], narrativeArcs: {} };
    try {
      const existing = await fs.readFile(MODEL_PATH, 'utf8');
      const parsed = JSON.parse(existing);
      cumulativeModel.dramaticPlays   = parsed.dramaticPlays   || {};
      cumulativeModel.predictionHistory = parsed.predictionHistory || [];
      cumulativeModel.narrativeArcs   = parsed.narrativeArcs   || {};
    } catch (e) {}

    // Defensive initialization
    if (!cumulativeModel.dramaticPlays)   cumulativeModel.dramaticPlays = {};
    if (!cumulativeModel.predictionHistory) cumulativeModel.predictionHistory = [];
    if (!cumulativeModel.narrativeArcs)   cumulativeModel.narrativeArcs = {};

    const nextActNumber = (cumulativeModel.dramaticPlays?.[domain]?.length || 0) + 1;

    // Load trimmed hypotheses
    const mergedHypotheses = await loadAndMergeHypotheses(domain, cumulativeModel, isTraditional);

   // Audit log for active canonical hypotheses
const activeCanonicalClaims = mergedHypotheses.filter(h => h.source === "canonical");
if (activeCanonicalClaims.length > 0) {
  console.log(`🔥 [CRITICAL] Canonical Hypothesis Active for Act ${nextActNumber}!`);
  activeCanonicalClaims.forEach(h => {
    console.log(`   📜 ID: [${h.id}] | Active Context: "${h.claim.substring(0, 95)}..."`);
  });
} else {
  console.log(`ℹ️ No canonical hypotheses registered for the [${domain}] domain this run.`);
}

    // Build hypothesis block
    let hypothesisBlock = '';
    if (mergedHypotheses.length > 0) {
      hypothesisBlock = `### RUNTIME HYPOTHESES IN PLAY\n`;
      mergedHypotheses.forEach((h, idx) => {
        const originTag = h.source === "canonical" ? "CANONICAL" : "AI CONJECTURE";
        hypothesisBlock += `${idx + 1}. [${originTag}] ${h.claim}\n`;
      });
    }

    // === NEW: Build narrative context for story continuity ===
    const narrativeResult = await buildNarrativeContext(domain, cumulativeModel);
    const narrativeContext = narrativeResult.context;
    forecastsInjectedThisRun += narrativeResult.injected;

    // === USER PROMPT ASSEMBLY ===
    let userPrompt = selPrompt.chat;

    // ... (rest of the prompt assembly remains the same)

    // IDEOGRAM INTERCEPTOR: If --ideogram is active, swap out the natural language 
    // image instructions for a strict minified layout JSON contract.
    if (useIdeogram) {
      const ideogramJSONRules = `## IMAGE PROMPT
CRITICAL IMAGE GENERATION RULES:
1. You MUST output exactly one clean, valid, single-line minified JSON object matching the contract below. Do not wrap it in markdown code fences or add conversational notes.
2. Define a master 'high_level_description' framing the overall composition, medium, and atmosphere based on the active act.
3. Populate the 'compositional_deconstruction' object with a 'background' description and an 'elements' array containing 1 to 3 core objects or typography layers mapped to coordinates on a 0 to 1000 grid layout [y_min, x_min, y_max, x_max].

Target Format Blueprint:
{"aspect_ratio":"9:16","high_level_description":"A theatrical stage set layout...","compositional_deconstruction":{"background":"A stark digital lattice shell...","elements":[{"type":"obj","bbox":[450,200,850,750],"desc":"A glowing artifact center stage"}]}}`;

      // Surgically swap out the visual prompt block instructions before sending to the LLM
      userPrompt = userPrompt.replace(/## IMAGE PROMPT[\s\S]*?## T2V PROMPT/i, `${ideogramJSONRules}\n\n## T2V PROMPT`);
    }

    // === TRADITIONAL VERSE MODE INSTRUCTION SWAP ===
    if (isTraditional) {
      const traditionalVerseInstructions =
        "[Write traditional metrical rhymed verse in a unified lyrical voice. Do not use named character dialogue, stage directions, or theatrical play format. Focus on compressed insight, symbolic imagery, musical language, direct observation, and thematic resonance. Maintain perfect end-rhymes and consistent meter across stanzas.]";

      userPrompt = userPrompt.replace(
        /\[Write bold, unflinching, truth-revealing metrical rhymed verse dialogue featuring named characters and stage directions\..*?Maintain strict metrical and rhyme discipline\.\]/s,
        traditionalVerseInstructions
      );
    }

    // Token replacements
        // === NEW: Inject narrative context ===
    userPrompt = userPrompt.replace(/\[\[narrative_context\]\]/g, narrativeContext);
    if (!userPrompt.includes('[[narrative_context]]')) {
      userPrompt = narrativeContext + "\n\n" + userPrompt;
    }
    userPrompt = userPrompt.replace(/\[\[chunk\]\]/g, richContextBlock);

    const dynamicStylesString = getShuffledAceStyles();
    userPrompt = userPrompt.replace(/\[\[ace_styles\]\]/g, dynamicStylesString);

    userPrompt = userPrompt.replace(/\[\[act_number\]\]/g, nextActNumber.toString());

    // === NEW: Inject narrative context ===
    userPrompt = userPrompt.replace(/\[\[narrative_context\]\]/g, narrativeContext);
    if (!userPrompt.includes('[[narrative_context]]')) {
      userPrompt = narrativeContext + "\n\n" + userPrompt;
    }

    // Inject hypotheses
    if (userPrompt.includes('[[hypotheses_block]]')) {
      userPrompt = userPrompt.replace(/\[\[hypotheses_block\]\]/g, hypothesisBlock);
    } else {
      userPrompt += `\n\n${hypothesisBlock}`;
    }

// Mode-specific mandatory instructions (kept minimal to avoid conflicting with prompt files)
if (!isTraditional) {
  userPrompt += `\n\n--- MODE-SPECIFIC REQUIREMENTS ---\n`;
  userPrompt += `- The CHORUS/refrain section must directly articulate the collision of your active hypotheses and the underlying forecast.\n`;
}

    // Generate
    const rawOutput = await generateText(selPrompt.system, userPrompt);
       const parsed = parseUnifiedOutput(rawOutput);

    // Count processed forecasts
    if (parsed.forecast && parsed.forecast.trim().length > 40) {
        forecastsProcessedThisRun++;
    }
    
        if (parsed.narrative_synthesis && parsed.narrative_synthesis.trim().length > 50) {
        const appended = await updateNarrativeArc(domain, parsed.narrative_synthesis, parsed.forecast, cumulativeModel);
        if (appended) forecastsAppendedThisRun++;
        await fs.writeFile(MODEL_PATH, JSON.stringify(cumulativeModel, null, 2));
        console.log(`📖 Narrative arc updated for [${domain}]`);
    }
    // Music tag sanitization
    let cleanTagsArray = (parsed.musicTags || "")
      .split(',')
      .map(t => t.trim())
      .filter(t => {
        if (!t) return false;
        const isVocalProfile = /\b(vocals|baritone|tenor|soprano|duet|singer|voice)\b/i.test(t);
        const isValidStyle = RAW_ACE_STYLES.some(style => style.toLowerCase() === t.toLowerCase());
        return isVocalProfile || isValidStyle;
      });

    if (cleanTagsArray.length === 0) {
      cleanTagsArray = ["Classical", "Instrumental"];
    }
    cleanTagsArray = cleanTagsArray.slice(0, 5);
    const safeMusicTagsString = cleanTagsArray.join(', ');
    console.log(`🎵 Sanitized Music Tags submitted to node: "${safeMusicTagsString}"`);

    // Commit to cumulative model (existing dramatic plays + prediction history)
    await updateUnifiedDomainModel(domain, nextActNumber, folder, parsed, mergedHypotheses);

    // ==========================================
    // MEDIA GENERATION (UNCHANGED)
    // ==========================================
    let imgRes = useGrokImagine
      ? await runGrokImagine(parsed.image, slugify(title))
      : (useGeminiImage ? await runGeminiImage(parsed.image, slugify(title)) : await runImageGen(parsed.image));
    if (!useGeminiImage) await freeComfyVRAM();

    let vidRes = useGeminiVideo
      ? await runGeminiVideo(parsed.t2v, slugify(title))
      : await runVideoGen(parsed.t2v, imgRes.filename, forceT2V || useHunyuan);
    if (!useGeminiVideo) await freeComfyVRAM();

    const ttsRes = await runPoetryTTS(parsed.verse);
    await freeComfyVRAM();

    const finalDuration = parseInt(parsed.musicDuration, 10) || generationDuration;
    let audioRes = useGeminiAudio
      ? await runGeminiAudio(safeMusicTagsString, parsed.musicLyrics, slugify(title))
      : await runAceStepGen(safeMusicTagsString, parsed.musicLyrics, slugify(title), finalDuration);
    if (!useGeminiAudio) await freeComfyVRAM();

    // MP4 stitching (optional)
    if (imgRes.success && audioRes.success) {
      try {
        await execFileAsync('ffmpeg', [
          '-loop', '1', '-framerate', '1',
          '-i', path.join(IMAGES_DIR, imgRes.filename),
          '-i', path.join(IMAGES_DIR, audioRes.filename),
          '-c:v', 'libx264', '-tune', 'stillimage',
          '-c:a', 'aac', '-b:a', '192k',
          '-pix_fmt', 'yuv420p', '-shortest', '-y',
          path.join(IMAGES_DIR, `x_ready_music_${slugify(title)}_${Date.now()}.mp4`)
        ]);
      } catch (e) {}
    }

    // Clean up raw audio intermediates
    const rawFlacDirScan = await fs.readdir(IMAGES_DIR);
    for (const file of rawFlacDirScan) {
      if (file.endsWith('.flac') || file.endsWith('.wav')) {
        await safeUnlink(path.join(IMAGES_DIR, file));
      }
    }

    // === BUILD ASTRO MARKDOWN POST ===
    const postDate = new Date().toISOString();

    const frontMatter = [
      `title: ${JSON.stringify(`${title} – Transmuted Pass`)}`,
      `date: "${postDate}"`,
      `pubDate: "${postDate.split('T')[0]}"`,
      `author: ${JSON.stringify((useGrok ? 'Grok' : 'Gemini') + ' + Core Single Pass Pipeline')}`,
      `source: "thread"`,
      `domain: ${JSON.stringify(domain)}`,
      `act: ${nextActNumber}`
    ];

    if (imgRes.success) frontMatter.push(`image: "/images/${imgRes.filename}"`);
    if (vidRes.success) frontMatter.push(`video: "/images/${vidRes.filename}"`);

// === HUMAN-READABLE IDEOGRAM PROMPT EXTRACTION ===
    let displayImagePrompt = parsed.image || '_No image prompt generated._';

    if (useIdeogram && parsed.image.trim().startsWith('{')) {
      try {
        const jsonPromptObj = JSON.parse(parsed.image.trim());
        if (jsonPromptObj.high_level_description) {
          // Pull the clean natural sentence structure out of the JSON envelope
          displayImagePrompt = jsonPromptObj.high_level_description;
          
          // Optional: If you want to also list the specific element descriptions, append them:
          if (jsonPromptObj.compositional_deconstruction?.elements?.length > 0) {
            displayImagePrompt += "<br><br><strong>Compositional Elements:</strong><ul>" + 
              jsonPromptObj.compositional_deconstruction.elements
                .map(el => `<li><code>${el.type.toUpperCase()}</code>: ${el.desc || el.text || ''}</li>`)
                .join('') + "</ul>";
          }
        }
      } catch (e) {
        console.warn("⚠️ Failed to parse image layout JSON for markdown display view, using raw string.");
        displayImagePrompt = parsed.image;
      }
    }    

const markdownPost = `---
${frontMatter.join('\n')}
---

## Navigation
- [Ongoing Narrative Arc](#ongoing-narrative-arc)
- [Primary Poetic Artifact](#primary-poetic-artifact)
- [Kinetic Dynamic Video](#kinetic-dynamic-video)
- [Visual Anchor Representation](#visual-anchor-representation)
- [Generated Musical Score](#generated-musical-score)
- [Pipeline & Debug Analytics](#pipeline-and-debug-analytics)

---

${originalThematicPoem && originalThematicPoem.length > 60 && originalThematicPoem.length < 700 ? `
### Thematic Seed

<div class="thematic-seed">
${originalThematicPoem.split('\n').map(line => line.trim() ? `<p>${line}</p>` : '').join('')}
</div>
` : ''}

## Ongoing Narrative Arc

${parsed.narrative_synthesis || '_No narrative synthesis generated this cycle._'}

${parsed.forecast && parsed.forecast.length > 30 ? `

### Forecast

${parsed.forecast}
` : ''}

---

### Primary Poetic Artifact

<div class="poetry-verse">
${parsed.verse || '_Poetic text generation unavailable._'}
</div>

${ttsRes.markdown || ''}

---

### Kinetic Dynamic Video

${vidRes.markdown || '_Kinetic video tracking element skipped._'}

##### Video Generation Prompt
<blockquote>
<strong>Target Prompt Parameters:</strong> ${parsed.t2v || '_No video prompt generated._'}
</blockquote>

---

### Visual Anchor Representation

${imgRes.markdown || '_Visual anchor asset rendering unavailable._'}

##### Image Generation Prompt
<blockquote>
<strong>Target Prompt Parameters:</strong> ${displayImagePrompt}
</blockquote>

---

### Generated Musical Score

${audioRes.markdown || '_Generated background score audio embed is unavailable._'}

##### Musical Score Vocal & Instrument Prompt Mapping
<blockquote>
<strong>Target Music Metadata Tags:</strong> <code>${parsed.musicTags}</code><br>
<strong>Target Score Audio Duration:</strong> ${finalDuration} seconds
</blockquote>
<pre>${parsed.musicLyrics || '_No lyrical words configuration found._'}</pre>

---

<h2 id="pipeline-and-debug-analytics">Pipeline & Debug Analytics</h2>

<strong>Active Text Inference Core Platform:</strong> <code>${actualModelUsed}</code><br>
<strong>Style Context Profile:</strong> <code>${selPrompt.name}.json</code><br>
<strong>Image Asset Processing Worker:</strong> <code>${imgRes.engine || 'Skipped/Failed'}</code><br>
<strong>Video Asset Processing Worker:</strong> <code>${vidRes.engine || 'Skipped/Failed'}</code><br>
<strong>TTS Spoken Audio Worker:</strong> <code>${ttsRes.engine || 'Skipped/Failed'}</code><br>
<strong>Soundtrack Audio Score Worker:</strong> <code>${audioRes.engine || 'Skipped/Failed'}</code>

<br>

<details>
<summary>Complete Core Prompt Log</summary>

#### System Directive
\`\`\`text
${selPrompt.system}
\`\`\`

#### Final Prompt Payload
\`\`\`text
${userPrompt}
\`\`\`

</details>
`;

    // Collision-proof file writing
    const baseSlug = `${slugify(title).substring(0, 40)}-${folder}-${Date.now()}`;
    let finalFilePath = path.join(POSTS_DIR, `${baseSlug}.md`);
    let counter = 1;

    while (true) {
      try {
        await fs.access(finalFilePath);
        finalFilePath = path.join(POSTS_DIR, `${baseSlug}-${counter}.md`);
        counter++;
      } catch {
        break;
      }
    }

    await fs.writeFile(finalFilePath, markdownPost, 'utf8');
    console.log(`💾 Build completed. Post synchronized cleanly with audio embed: ${path.basename(finalFilePath)}`);
    await freeComfyVRAM();
  }

  // === One-line summary log ===
  console.log(`\n📊 Run complete — ${forecastsProcessedThisRun} processed | ${forecastsAppendedThisRun} appended | ${forecastsInjectedThisRun} injected.`);
}

main().catch(err => { console.error("Fatal pipeline loop exception:", err); process.exit(1); });
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const { execFile, execSync } = require('child_process');
const util = require('util');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { writeFileSync } = require('fs');
const execFileAsync = util.promisify(execFile);

const MAX_CANONICAL_HYPOTHESES = 2;
const MAX_AI_HYPOTHESES = 2;

// --- CONFIGURATION MAPS ---
const PROMPTS_DIR = path.join(__dirname, 'prompts-dramatic-v7');
const CANONICAL_HYPOTHESES_DIR = path.join(__dirname, 'canonical-hypotheses');
const CANONICAL_HYPOTHESES_FILE = path.join(__dirname, 'canonical-hypotheses.json');
const POSTS_DIR = 'posts';
const IMAGES_DIR = 'images';
const X_DIR = './x';
const PROMPT_STATE_FILE = path.join(__dirname, '.prompt_state.json');
const MODEL_PATH = 'cumulative_thread_model.json';

const MODEL_GROK = "grok-4.7";
const MAX_CHARS_GEMINI = 1900000;
const MAX_CHARS_GROK = 50000;

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

const DEFAULT_REF_POOL_DIR = path.join(__dirname, 'ref_audio_pool');

async function resolveReferenceAudio(refArgValue) {
  let targetPoolDir = DEFAULT_REF_POOL_DIR;

  if (refArgValue && refArgValue !== 'true' && refArgValue !== 'pool' && refArgValue !== 'auto') {
    try {
      const stats = await fs.stat(refArgValue);
      if (stats.isFile()) {
        console.log(`\n🎧 [Ref-Audio] Explicit anchor audio track locked:`);
        console.log(`   👉 File: ${path.basename(refArgValue)} (${refArgValue})\n`);
        return refArgValue;
      }
      if (stats.isDirectory()) {
        targetPoolDir = refArgValue;
        console.log(`🎧 [Ref-Audio Pool] Pointing to custom directory: ${targetPoolDir}`);
      }
    } catch {
      console.warn(`⚠️ Path not found (${refArgValue}). Falling back to default pool.`);
    }
  }

  try {
    await fs.mkdir(targetPoolDir, { recursive: true });
    const entries = await fs.readdir(targetPoolDir);
    const audioFiles = entries.filter(f => /\.(opus|mp4|wav|flac|mp3)$/i.test(f));

    if (audioFiles.length > 0) {
      const chosen = audioFiles[Math.floor(Math.random() * audioFiles.length)];
      const chosenPath = path.join(targetPoolDir, chosen);
      
      console.log(`\n======================================================================`);
      console.log(`🎧 [REF-AUDIO POOL] ANCHOR REFERENCE CONDITIONING SELECTED:`);
      console.log(`   👉 Selected File : ${chosen}`);
      console.log(`   👉 Pool Directory: ${targetPoolDir}`);
      console.log(`======================================================================\n`);

      return chosenPath;
    } else {
      console.log(`\nℹ️ [Ref-Audio Pool] Directory is empty (${targetPoolDir}). Running unconditioned.\n`);
    }
  } catch (err) {
    console.warn(`⚠️ Error reading ref-audio pool: ${err.message}`);
  }

  return null;
}

function getShuffledAceStyles() {
  const filtered = RAW_ACE_STYLES.filter(style => !EXCLUDED_STYLES.includes(style));
  for (let i = filtered.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [filtered[i], filtered[j]] = [filtered[j], filtered[i]];
  }
  return filtered.join(', ');
}

// =========================================================================
// 1. CLI FLAGS & ARGUMENT PARSING
// =========================================================================
const args = process.argv.slice(2);

// Image Engine Flag Extraction
let t2iModel = "z_turbo";
const t2iArgIndex = args.findIndex(arg => arg === "--t2i" || arg === "-t");
if (t2iArgIndex !== -1 && args[t2iArgIndex + 1]) {
  const modelArg = args[t2iArgIndex + 1].toLowerCase();
  if (["qwen", "qwen-image", "qwen2.1"].includes(modelArg)) {
    t2iModel = "qwen";
  } else if (modelArg === "lens") {
    t2iModel = "lens";
  } else if (["zturbo", "z-turbo", "z_turbo"].includes(modelArg)) {
    t2iModel = "z_turbo";
  } else {
    t2iModel = modelArg;
  }
}

const noMemory = args.includes('--no-memory');
const useGrok = args.includes('--grok');
const forceT2V = args.includes('--t2v'); 
const useLens = args.includes('--lens') || t2iModel === 'lens'; 
const useQwen = args.includes('--qwen') || t2iModel === 'qwen'; 
const useYue = args.includes('--yue') || args.includes('--yue2');
const useGeminiImage = args.includes('--gemini-image');
const useGeminiAudio = args.includes('--gemini-audio');
const useGeminiVideo = args.includes('--gemini-video');
const useGrokImagine = args.includes('--grok-imagine');
const useLimericks = args.includes('--limericks');   
const useCanonical = args.includes('--canonical');   
const useFortune = args.includes('--fortune');       

let customIdea = null;
const ideaArg = args.find(a => a.startsWith('--idea='));
if (ideaArg) {
  customIdea = ideaArg.split('=').slice(1).join('=').trim();
}

const rawRefArg = args.find(a => /^--?ref-audio(=|$)/i.test(a));
const refAudioSetting = rawRefArg 
  ? (rawRefArg.includes('=') ? rawRefArg.split('=').slice(1).join('=').trim() : 'pool')
  : null;

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

        let isDuplicate = false;
        for (const existing of seen) {
            if (jaccardSimilarity(norm, existing) > 0.65) {
                isDuplicate = true;
                break;
            }
        }
        if (isDuplicate) continue;

        let inCooldown = false;
        for (const recent of recentHistory) {
            if (jaccardSimilarity(norm, recent) > 0.70) {
                inCooldown = true;
                break;
            }
        }
        if (inCooldown) continue;

        const isGatekeepingClaim = /institutional gatekeeping|ai-origin cinema|dropped project|narrative containment|de-facto veto/i.test(h.claim);
        if (isGatekeepingClaim && result.length > 0) {
            continue;
        }

        seen.push(norm);
        result.push(h);

        if (result.length >= maxItems) break;
    }

    return result;
}

function isStrongHypothesis(claim) {
    if (!claim || typeof claim !== 'string') return false;
    const trimmed = claim.trim();
    if (trimmed.length < 120) return false;
    const lower = trimmed.toLowerCase();
    if (lower.includes('no new') || lower.includes('no hypothesis')) return false;
    if (/institutional gatekeeping|ai-origin cinema|dropped project|narrative containment/i.test(trimmed)) {
        return false;
    }
    return true;
}

/**
 * Image coordinator with cloud-first track and local Lens fallback.
 */
async function executeImagePipeline(promptText, slug) {
  const API_KEY = process.env.GEMINI_API_KEY1;
  const filename = `img_${slug}_${Date.now()}.jpg`;
  const outputDestination = path.join(process.cwd(), 'site/public/images', filename);

  if (API_KEY) {
    const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-image:generateContent?key=${API_KEY}`;
    
    try {
      console.log(`\n🤖 [Cloud Track] Querying Nano Banana 2 Lite (9:16 aspect ratio)...`);
      
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            imageConfig: {
              aspectRatio: "9:16"
            }
          }
        })
      });

      if (!response.ok) {
        const apiErrorMsg = await response.text();
        throw new Error(`Google API Gate Reject (${response.status}): ${apiErrorMsg}`);
      }

      const data = await response.json();
      const finishReason = data.candidates?.[0]?.finishReason;
      if (finishReason && finishReason !== "STOP") {
        throw new Error(`Inference blocked by safety rules. Reason code: ${finishReason}`);
      }

      let base64Bytes = null;
      const parts = data.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.inlineData && part.inlineData.data) {
          base64Bytes = part.inlineData.data;
          break;
        }
      }

      if (!base64Bytes) {
        throw new Error("API returned status 200, but payload candidates lacked inline image bytes.");
      }

      writeFileSync(outputDestination, Buffer.from(base64Bytes, 'base64'));
      console.log(`⚡ Cloud Render Successful! Saved to target: ${outputDestination}`);

      return {
        success: true,
        filename: filename,
        engine: "Gemini Nano Banana 2 Lite",
        markdown: `<p><img src="/images/${filename}" style="max-width:100%; border-radius:8px;" alt="Visual Anchor" /></p>`
      };

    } catch (cloudError) {
      console.error(`❌ Cloud Generation Failed: ${cloudError.message}`);
    }
  }

  console.log(`🔄 Initiating local fallback array chain...`);
  const localModules = ['run_lens.js'];
  const stateFile = path.join(os.tmpdir(), `fallback-state-${Date.now()}.json`);
  
  for (const scriptFile of localModules) {
    try {
      console.log(`🎨 [Fallback Track] Invoking native local module: ${scriptFile}...`);
      require('fs').writeFileSync('prompt.txt', promptText || 'Abstract composition', 'utf8');
      
      const scriptPath = path.join(process.cwd(), scriptFile);
      execSync(`bun run ${scriptPath} --state-file ${stateFile}`, { stdio: 'inherit' });

      const state = JSON.parse(require('fs').readFileSync(stateFile, 'utf8'));
      const localFilename = state.filename;

      if (localFilename) {
        console.log(`✅ Local compilation successful via ${scriptFile}: ${localFilename}`);
        const localSrcPath = path.join(process.cwd(), 'images', localFilename);
        const targetDestPath = path.join(process.cwd(), 'site/public/images', localFilename);
        require('fs').copyFileSync(localSrcPath, targetDestPath);
        
        try { require('fs').unlinkSync('prompt.txt'); } catch(e){}
        try { require('fs').unlinkSync(stateFile); } catch(e){}

        return {
          success: true,
          filename: localFilename,
          engine: 'Lens',
          markdown: `<p><img src="/images/${localFilename}" style="max-width:100%; border-radius:8px;" alt="Visual Anchor" /></p>`
        };
      }
    } catch (fallbackError) {
      console.error(`⚠️ Local module ${scriptFile} failed: ${fallbackError.message}`);
    }
  }

  try { require('fs').unlinkSync('prompt.txt'); } catch(e){}
  try { require('fs').unlinkSync(stateFile); } catch(e){}

  return { success: false, filename: '', engine: 'Failed All Tracks', markdown: '' };
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
    const combined = (arc.currentArc + "\n\n" + newNarrativeText).trim();
    arc.currentArc = combined.length > 4500 ? combined.slice(-4200) : combined;

    let forecastAppended = false;
    if (parsedForecast && parsedForecast.trim().length > 40) {
        if (!arc.forecastHistory) arc.forecastHistory = [];
        
        arc.forecastHistory.push({
            act: (cumulativeModel.dramaticPlays?.[domain]?.length || 0) + 1,
            timestamp: new Date().toISOString(),
            forecast: parsedForecast.trim()
        });

        if (arc.forecastHistory.length > 6) {
            arc.forecastHistory = arc.forecastHistory.slice(-6);
        }
        forecastAppended = true;
    }

    arc.lastUpdated = new Date().toISOString();
    return forecastAppended; 
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
    forecast: '',           
    hypothesis: '', 
    hypothesis_limerick: '',
    diagram: '', // <-- 1. ADD DIAGRAM TARGET
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
    } else if (l.match(/^(#+|\*\*|__|-)*\s*(forecast|prediction)/i)) {   
        current = 'forecast';
    } else if (l.match(/^(#+|\*\*|__|-)*\s*(hypothesis|paradigm)\s*limerick/i)) {
        current = 'hypothesis_limerick';
    } else if (l.match(/^(#+|\*\*|__|-)*\s*(semantic (architecture )?diagram|mermaid( diagram)?)/i)) { // <-- 2. MATCH DIAGRAM HEADER
        current = 'diagram';
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

  const verse = cleanVerseText(sections.verse);
  const forecast = sections.forecast.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').replace(/\*\*|__|###/g, '').trim();
  const hypothesis = sections.hypothesis.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').replace(/\*\*|__|###/g, '').trim();
  const hypothesisLimerick = cleanVerseText(sections.hypothesis_limerick);

  // 3. CLEAN & NORMALIZE MERMAID BLOCK
  let rawDiagram = sections.diagram.trim();
  let diagram = '';
  if (rawDiagram) {
    const match = rawDiagram.match(/```(?:mermaid)?([\s\S]*?)```/i);
    if (match) {
      diagram = `\`\`\`mermaid\n${match[1].trim()}\n\`\`\``;
    } else if (rawDiagram.includes('graph ') || rawDiagram.includes('flowchart ')) {
      diagram = `\`\`\`mermaid\n${rawDiagram}\n\`\`\``;
    }
  }

  let rawMusic = sections.music.trim().replace(/```[a-z]*\n?/gi, '').replace(/```/g, '');
  
  let tags = "Folk, Americana, Bluegrass, Country, Acoustic Guitar";
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
    forecast: forecast,                    
    hypothesis: hypothesis,
    hypothesisLimerick: hypothesisLimerick,
    diagram: diagram, // <-- 4. EXPORT DIAGRAM
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
      reasoning_effort: "low",
      max_tokens: 8192
    };
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.XAI_API_KEY}` },
      body: JSON.stringify(payload)
    });
    const bodyText = await res.text();
    let data = {};
    try { data = JSON.parse(bodyText); } catch { data = {}; }

    const choice = data.choices?.[0];
    const msg = choice?.message || {};
    const content = String(msg.content || '').trim();
    if (/(can'?t|cannot|unable to|won'?t)\s+(help|comply|generate|create|assist)|content.?policy|against (my|the) (guidelines|policies)/i.test(content.slice(0, 400))) {
      console.error(`🚫 Grok refusal — aborting. ${content.slice(0, 280)}`);
      process.exit(1);
    }
    const finish = choice?.finish_reason || choice?.native_finish_reason || '';
    const refusal =
      data.error?.message ||
      data.error ||
      msg.refusal ||
      (!res.ok && `HTTP ${res.status}: ${bodyText.slice(0, 400)}`) ||
      (finish && !/^stop$/i.test(finish) && `finish_reason=${finish}`) ||
      (!content && (msg.reasoning_content ? 'empty content (reasoning only)' : 'empty content')) ||
      '';

    if (refusal || !content) {
      const reason = String(refusal || 'empty Grok content').slice(0, 500);
      console.error(`🚫 Grok refusal — aborting. ${reason}`);
      process.exit(1);
    }

    actualModelUsed = MODEL_GROK;
    return content;
  } else {
    console.log("Generating with Gemini...");
    for (const modelName of ["gemini-3.1-pro-preview", "gemini-3-flash-preview"]) {
      try {
        const model = genAI.getGenerativeModel({ 
          model: modelName, 
          generationConfig: { temperature: 1 },
          systemInstruction: system
        });
        
        const res = await model.generateContent(truncatedUser);
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
// MEDIA CORES GENERATION ARTIFACTS
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
    
    let runnerArgs = useLens ? ['run_lens.js'] : 
                     (useQwen ? ['run_qwen.js'] : ['run_z_turbo.js']);

    await execFileAsync('bun', [...runnerArgs, '--state-file', stateFile]);
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    const finalFilename = state.filename;

    const engineName = runnerArgs[0] === 'run_qwen.js' ? 'Qwen-Image 2.1' :
                       (runnerArgs[0] === 'run_lens.js' ? 'Lens' : 'Z-Turbo');

    return { 
      success: true, 
      filename: finalFilename, 
      engine: engineName, 
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
    let runnerArgs = ['run_ltx_video.js', '--state-file', stateFile, '--prompt', videoPrompt];
    if (isT2V) {
      runnerArgs.push('--t2v');
    } else if (anchorImageName) {
      runnerArgs.push('--image', anchorImageName);
    }

    await execFileAsync('bun', runnerArgs);
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    const filename = state.filename || path.basename(state.savedFilePath);
    return { 
      success: true, 
      filename: filename, 
      engine: "LTX-Video", 
      markdown: `\n<p><video controls src="/images/${filename}" style="max-width:100%; border-radius:8px;" loop muted></video></p>\n` 
    };
  } catch (e) { 
    console.error(`Video generation worker failed: ${e.message}`); 
    return { success: false, markdown: '' }; 
  } finally { 
    await safeUnlink(stateFile); 
  }
}

async function runPoetryTTS(poemText) {
    const stateFile = path.join(os.tmpdir(), `tts-state-${Date.now()}.json`);
    const poemFile = 'temp_poem.txt';
    try {
        await fs.writeFile(poemFile, poemText || 'Silence.', 'utf8');
        await execFileAsync('bun', ['run_kokoro_tts.js', '--state-file', stateFile, '--prompt-file', poemFile]);
        const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
        
        const rawFlacPath = state.savedFilePath;
        const finalOpusFilename = state.filename.replace(/\.(flac|wav)$/, '.opus');
        const finalOpusPath = path.join(IMAGES_DIR, finalOpusFilename);

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
        return { 
          success: true, 
          filename: finalOpusFilename, 
          engine: 'Kokoro', 
          markdown: `\n<p><audio controls src="/images/${finalOpusFilename}"></audio></p>\n` 
        };
    } catch (e) { 
      console.error(`TTS synthesis failed: ${e.message}`); 
      return { success: false, markdown: '' }; 
    } finally { 
      await safeUnlink(stateFile); 
      await safeUnlink(poemFile); 
    }
}

async function runAceStepGen(tags, lyrics, slug, duration, referenceAudio = null) {
    const stateFile = path.join(os.tmpdir(), `acestep-state-${Date.now()}.json`);
    try {
        let runnerArgs = [
          'run_acestep.js', 
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
          } catch (_) {}

          refAudioMarkdown = `\n<div class="reference-audio-embed" style="margin: 0.75rem 0 1.25rem;">
  <p style="font-size: 0.85em; margin-bottom: 4px; opacity: 0.8;">🎧 <strong>Anchor Reference Audio (${refAudioName}):</strong></p>
  <audio controls src="/images/${refAudioName}"></audio>
</div>\n`;
        }

        await execFileAsync('bun', runnerArgs);
        const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
        const rawFlacPath = state.savedFilePath;
        const opusFilename = `acestep_${slug}_${Date.now()}.opus`;
        const opusPath = path.join(IMAGES_DIR, opusFilename);

        await execFileAsync('ffmpeg', ['-y', '-i', rawFlacPath, '-af', `afade=t=out:st=${Math.max(0, duration - 5)}:d=5`, '-c:a', 'libopus', '-b:a', '128k', opusPath]);
        
        await safeUnlink(rawFlacPath);
        return { 
          success: true, 
          filename: opusFilename, 
          engine: "ACE-Step 1.5", 
          refAudioName: refAudioName || 'None (Unconditioned)',
          refAudioMarkdown: refAudioMarkdown,
          markdown: `\n<p><audio class="soundtrack-audio" controls src="/images/${opusFilename}"></audio></p>\n` 
        };
    } catch (e) { 
      console.error(`ACE-Step pipeline execution failed: ${e.message}`); 
      return { success: false, refAudioName: 'None', refAudioMarkdown: '', markdown: '' }; 
    } finally { 
      await safeUnlink(stateFile); 
    }
}

async function runYueGen(tags, lyrics, slug, duration, referenceAudio = null) {
    const stateFile = path.join(os.tmpdir(), `yue-state-${Date.now()}.json`);
    try {
        let runnerArgs = [
          'run_yue.js', 
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
          try { await fs.copyFile(referenceAudio, destRefPath); } catch (_) {}
          refAudioMarkdown = `\n<div class="reference-audio-embed" style="margin: 0.75rem 0 1.25rem;">
  <p style="font-size: 0.85em; margin-bottom: 4px; opacity: 0.8;">🎧 <strong>Anchor Reference Audio (${refAudioName}):</strong></p>
  <audio controls src="/images/${refAudioName}"></audio>
</div>\n`;
        }

        await execFileAsync('bun', runnerArgs);
        const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
        const rawFlacPath = state.savedFilePath;
        const opusFilename = `yue2_${slug}_${Date.now()}.opus`;
        const opusPath = path.join(IMAGES_DIR, opusFilename);

        // Mirror Opus to Astro site/public/images
        await execFileAsync('ffmpeg', [
          '-y', '-i', rawFlacPath, 
          '-af', `afade=t=out:st=${Math.max(0, duration - 5)}:d=5`, 
          '-c:a', 'libopus', '-b:a', '128k', opusPath
        ]);
        const astroPublicDir = path.join(process.cwd(), 'site/public/images');
        if (require('fs').existsSync(astroPublicDir)) {
          require('fs').copyFileSync(opusPath, path.join(astroPublicDir, opusFilename));
        }

        await safeUnlink(rawFlacPath);

        return { 
          success: true, 
          filename: opusFilename, 
          engine: "YuE2 3B (BF16)", 
          refAudioName: refAudioName || 'None (Unconditioned)',
          refAudioMarkdown: refAudioMarkdown,
          abcScore: state.abcScore || '',
          abcFilename: state.abcFilename || '',
          midiFilename: state.midiFilename || '',
          markdown: `\n<p><audio class="soundtrack-audio" controls src="/images/${opusFilename}"></audio></p>\n`
        };
    } catch (e) { 
      console.error(`YuE2 pipeline execution failed: ${e.message}`); 
      return { success: false, refAudioName: 'None', refAudioMarkdown: '', markdown: '' }; 
    } finally { 
      await safeUnlink(stateFile); 
    }
}


// ==========================================
// MEMORY MAP & HYPOTHESES LIFECYCLES
// ==========================================
async function updateUnifiedDomainModel(domain, nextActNumber, folder, parsedOutput, activeHypotheses) {
    let model = { dramaticPlays: {}, predictionHistory: [], narrativeArcs: {} };

    try {
        const existing = await fs.readFile(MODEL_PATH, 'utf8');
        model = JSON.parse(existing);
    } catch (e) {}

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

    const prospectiveHypothesis = parsedOutput.hypothesis_elaboration_ai || parsedOutput.hypothesis;
    if (prospectiveHypothesis && isStrongHypothesis(prospectiveHypothesis)) {
        model.predictionHistory.push({
            timestamp: new Date().toISOString(),
            actRef: nextActNumber,
            domain: domain,
            hypothesis: prospectiveHypothesis.trim()
        });
    }

    if (parsedOutput.forecast && parsedOutput.forecast.trim().length > 40) {
        const arc = model.narrativeArcs[domain];
        if (!arc.forecastHistory) arc.forecastHistory = [];

        const forecastText = parsedOutput.forecast.trim();
        const benchmarkMatch = forecastText.match(/\*\*Benchmark\*\*\s*—\s*(.+?)(?=\n\*\*|$)/s);
        const triggerMatch   = forecastText.match(/\*\*Trigger Condition\*\*\s*—\s*(.+?)(?=\n\*\*|$)/s);
        const vectorMatch    = forecastText.match(/\*\*Expected Vector\*\*\s*—\s*(.+?)(?=\n|$)/s);

        arc.forecastHistory.push({
            act: nextActNumber,
            timestamp: new Date().toISOString(),
            forecast: forecastText,
            benchmark: benchmarkMatch ? benchmarkMatch[1].trim() : null,
            trigger: triggerMatch ? triggerMatch[1].trim() : null,
            expectedVector: vectorMatch ? vectorMatch[1].trim() : null
        });

        if (arc.forecastHistory.length > 8) {
            arc.forecastHistory = arc.forecastHistory.slice(-8);
        }
    }

    await fs.writeFile(MODEL_PATH, JSON.stringify(model, null, 2), 'utf8');
    console.log(`💾 Ledger state tracking committed to ${MODEL_PATH}`);
}

async function loadCanonicalHypotheses(domain) {
    let canonicalHyps = [];
    try {
        const files = await fs.readdir(CANONICAL_HYPOTHESES_DIR);
        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            const content = JSON.parse(await fs.readFile(path.join(CANONICAL_HYPOTHESES_DIR, file), 'utf8'));
            if (Array.isArray(content.hypotheses)) canonicalHyps.push(...content.hypotheses);
        }
    } catch (e) {
        try {
            const unified = JSON.parse(await fs.readFile(CANONICAL_HYPOTHESES_FILE, 'utf8'));
            if (Array.isArray(unified.hypotheses)) canonicalHyps = unified.hypotheses;
        } catch (_) {}
    }

    const domainLower = (domain || '').toLowerCase();
    return canonicalHyps.filter(h =>
        (h.domain || '').toLowerCase() === domainLower ||
        (h.domain || '').toLowerCase() === 'general'
    );
}

async function loadAndMergeHypotheses(domain, cumulativeModel, isTraditional = false, includeCanonical = false) {
    let selectedCanonical = [];
    let selectedAI = [];

    if (includeCanonical) {
        const filteredCanonical = await loadCanonicalHypotheses(domain);
        if (isTraditional) {
            selectedCanonical = filteredCanonical.slice(0, MAX_CANONICAL_HYPOTHESES);
        } else if (filteredCanonical.length > MAX_CANONICAL_HYPOTHESES) {
            selectedCanonical = filteredCanonical
                .map(h => ({ h, sort: Math.random() }))
                .sort((a, b) => a.sort - b.sort)
                .slice(0, MAX_CANONICAL_HYPOTHESES)
                .map(item => item.h);
        } else {
            selectedCanonical = filteredCanonical;
        }
    }

    if (cumulativeModel?.predictionHistory) {
        if (isTraditional) {
            const recent = cumulativeModel.predictionHistory
                .filter(entry => entry.hypothesis && entry.hypothesis.length > 25)
                .slice(-1);
            selectedAI = recent.map(entry => ({
                id: entry.id || `ai-${Date.now()}`,
                claim: entry.hypothesis,
                source: "ai"
            }));
        } else {
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

    return [
        ...selectedCanonical.map(h => ({ ...h, source: "canonical" })),
        ...selectedAI
    ];
}

async function buildNarrativeContext(domain, cumulativeModel) {
    if (!cumulativeModel.narrativeArcs || !cumulativeModel.narrativeArcs[domain]) {
        return { context: "Initial act of the narrative trajectory.", injected: 0 };
    }

    const arc = cumulativeModel.narrativeArcs[domain];
    
    let context = `--- HISTORICAL RECORD MEMORY LAYERS ---\n`;
    context += `${arc.currentArc || ''}\n\n`;
    context += `CRITICAL RUNTIME INSTRUCTION: Treat the historical records above strictly as background baseline. You are forbidden from repeating their specific phrasing, thematic metaphors, or titles.\n\n`;

    let injectedCount = 0;
    if (arc.forecastHistory && arc.forecastHistory.length > 0) {
        const recentForecasts = arc.forecastHistory.slice(-2);
        context += "--- RECENT UNRESOLVED PREDICTIVE TELEMETRY ---\n";
        recentForecasts.forEach((f) => {
            const shortForecast = f.forecast.length > 220 
                ? f.forecast.substring(0, 217) + "..." 
                : f.forecast;
            context += `Act ${f.act} Trajectory Projection: ${shortForecast}\n`;
        });

        injectedCount = recentForecasts.length;
        console.log(`   📜 Isolated Context: Injected ${injectedCount} historical telemetry metrics into stream.`);
    }

    return { context, injected: injectedCount };
}

// ==========================================
// MAIN RUNTIME LOOP
// ==========================================
async function main() {
  await Promise.all([fs.mkdir(POSTS_DIR, { recursive: true }), fs.mkdir(IMAGES_DIR, { recursive: true })]);

  let forecastsProcessedThisRun = 0;
  let forecastsAppendedThisRun = 0;
  let forecastsInjectedThisRun = 0;

  const prompts = await loadPrompts();
  if (prompts.length === 0) throw new Error(`No prompt files discovered inside ${PROMPTS_DIR}.`);

  let promptIndex = 0;
  try {
    const stateData = JSON.parse(await fs.readFile(PROMPT_STATE_FILE, 'utf8'));
    promptIndex = (Number(stateData.lastIndex) || 0) + 1;
  } catch (e) {}
  if (promptIndex >= prompts.length || isNaN(promptIndex)) promptIndex = 0;

  const selPrompt = prompts[promptIndex];
  await fs.writeFile(PROMPT_STATE_FILE, JSON.stringify({ lastIndex: promptIndex }));

  const VOICE_STATE_FILE = path.join(__dirname, '.voice_state.json');
  const VOICE_CYCLE = [
    "Bass-Baritone male vocals",
    "Mezzo-Soprano female vocals",
    "Lyric Tenor male vocals",
    "Dramatic Soprano female vocals"
  ];

  let voiceIndex = 0;
  try {
    const vStateData = JSON.parse(await fs.readFile(VOICE_STATE_FILE, 'utf8'));
    voiceIndex = (Number(vStateData.lastIndex) || 0) + 1;
  } catch (e) {}
  if (voiceIndex >= VOICE_CYCLE.length || isNaN(voiceIndex)) voiceIndex = 0;

  const assignedVoice = VOICE_CYCLE[voiceIndex];
  await fs.writeFile(VOICE_STATE_FILE, JSON.stringify({ lastIndex: voiceIndex }), 'utf8');

  console.log(`🎙️ Stateful Voice Assigned for Run: [${assignedVoice}]`);

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
    const originalThematicPoem = payload.grok_poem || '';

    let richContextBlock = `THEMATIC SUMMARY:\n${payload.grok_poem || ''}\n\nRAW SOURCES TO TRANSMUTE:\n`;
    (payload.sources || []).forEach((src, idx) => {
      richContextBlock += `\n--- SOURCE ${idx + 1} ---\nURL: ${src.url}\nDATA ANALYSIS:\n${src.rich_text || src.description_short}\n`;
    });
    
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

    let cumulativeModel = { dramaticPlays: {}, predictionHistory: [], narrativeArcs: {} };
    if (!noMemory) {
      try {
        const existing = await fs.readFile(MODEL_PATH, 'utf8');
        const parsed = JSON.parse(existing);
        cumulativeModel.dramaticPlays     = parsed.dramaticPlays   || {};
        cumulativeModel.predictionHistory = parsed.predictionHistory || [];
        cumulativeModel.narrativeArcs     = parsed.narrativeArcs   || {};
      } catch (e) {}
    }

    const nextActNumber = noMemory ? 1 : ((cumulativeModel.dramaticPlays?.[domain]?.length || 0) + 1);

    // Scriptorium Paradigm Selection
    let activeHypothesisPayload = "";
    let activeHypothesisMode = "CLEAN CORE RUN (No Paradigm Injection)";

    if (customIdea) {
      activeHypothesisPayload = customIdea;
      activeHypothesisMode = "DIRECT INJECTED IDEA PARADIGM";
    } else if (useLimericks) {
      try {
        activeHypothesisPayload = execSync('fortune limericks', { encoding: 'utf8' }).trim();
        activeHypothesisMode = "SYSTEM LIMERICK SUBVERSION ACTIVE";
      } catch (err) {
        console.warn("   ⚠️ Scriptorium Alert: fortune limericks execution failed.");
      }
    } else if (useCanonical) {
      const canonicalClaims = await loadCanonicalHypotheses(domain);
      if (canonicalClaims.length > 0) {
        const chosen = canonicalClaims[Math.floor(Math.random() * canonicalClaims.length)];
        activeHypothesisPayload = chosen.claim;
        activeHypothesisMode = `CANONICAL SYSTEM LOG Matrix ON [Domain: ${domain.toUpperCase()}]`;
        console.log(`🔥 [CANONICAL] Ingested Hypothesis Active for Act ${nextActNumber}:`);
        console.log(`   📜 ID: [${chosen.id || 'exploratory'}] | Claim: "${chosen.claim.substring(0, 95)}..."`);
      } else {
        try {
          const targetDbs = ["wisdom", "tao", "paradoxum", "politics"];
          const selectedDb = targetDbs[Math.floor(Math.random() * targetDbs.length)];
          activeHypothesisPayload = execSync(`fortune ${selectedDb}`, { encoding: 'utf8' }).trim().replace(/\s+/g, ' ');
          activeHypothesisMode = `CANONICAL FALLBACK: System Fortune Proverbs [File: ${selectedDb}]`;
        } catch (_) {}
      }
    } else if (useFortune) {
      try {
        const targetDbs = ["wisdom", "tao", "paradoxum", "politics"];
        const selectedDb = targetDbs[Math.floor(Math.random() * targetDbs.length)];
        activeHypothesisPayload = execSync(`fortune ${selectedDb}`, { encoding: 'utf8' }).trim().replace(/\s+/g, ' ');
        activeHypothesisMode = `SYSTEM FORTUNE PROVERBS ACTIVE [File: ${selectedDb}]`;
      } catch (err) {
        console.warn("   ⚠️ Scriptorium Alert: fortune path execution failed.");
      }
    }

    console.log(`\n======================================================================`);
    console.log(`🔮 [ORACLE ENGINE] EXECUTION NODE INITIALIZATION METRICS:`);
    console.log(`   👉 Target Execution Node  : ${folder.toUpperCase()}`);
    console.log(`   👉 Active Scriptorium Mode: ${activeHypothesisMode}`);
    if (activeHypothesisPayload) {
      console.log(`   👉 Active Injected Frame  :\n\n${activeHypothesisPayload}\n`);
    } else {
      console.log(`   👉 Active Injected Frame  : [Pure Data Pass - Completely Clean Arena]`);
    }
    console.log(`======================================================================\n`);

    // Hypothesis Compilation (Canonical claims are only merged when explicitly enabled)
    const mergedHypotheses = await loadAndMergeHypotheses(domain, cumulativeModel, isTraditional, useCanonical);
    let hypothesisBlock = '';
    
    if (activeHypothesisPayload) {
      hypothesisBlock = `### RUNTIME HYPOTHESES IN PLAY\n`;
      hypothesisBlock += `1. [SYSTEM INTEGRATED CONJECTURE] The context window has absorbed this active underlying proposition, which must explicitly filter and color all subsequent prose and metrical text blocks:\n"${activeHypothesisPayload}"\n\n`;
      
      const aiConjectures = mergedHypotheses.filter(h => h.source === "ai");
      aiConjectures.forEach((h, idx) => {
        hypothesisBlock += `${idx + 2}. [AI CONJECTURE] ${h.claim}\n`;
      });
    } else if (mergedHypotheses.length > 0) {
      hypothesisBlock = `### RUNTIME HYPOTHESES IN PLAY\n`;
      mergedHypotheses.forEach((h, idx) => {
        const originTag = h.source === "canonical" ? "CANONICAL" : "AI CONJECTURE";
        hypothesisBlock += `${idx + 1}. [${originTag}] ${h.claim}\n`;
      });
    }

    const narrativeResult = await buildNarrativeContext(domain, cumulativeModel);
    const narrativeContext = narrativeResult.context;
    forecastsInjectedThisRun += narrativeResult.injected;

    // Prompt Synthesis
    let userPrompt = selPrompt.chat;

    userPrompt = userPrompt.replace(
      /TAGS:\s*.*?(Bass-Baritone|Lyric Tenor|Mezzo-Soprano|Dramatic Soprano)\s*(male|female)?\s*vocals/gi,
      `TAGS: Folk, Americana, Instrumental, ${assignedVoice}`
    );
    userPrompt = userPrompt.replace(/### SONIC GENRE WHITELIST[\s\S]*$/, '').trim();
    userPrompt = userPrompt.replace(
      /## MUSIC PROMPT/i,
      "## MUSIC PROMPT\n\n### REFERENCE GENRE WHITELIST (CHOOSE 2-3 TERMS MAX FROM THIS LIST):\n[[ace_styles]]"
    );

    if (isTraditional) {
      const traditionalVerseInstructions =
        "[Write traditional metrical rhymed verse in a unified lyrical voice. Do not use named character dialogue, stage directions, or theatrical play format. Focus on compressed insight, symbolic imagery, musical language, direct observation, and thematic resonance. Maintain perfect end-rhymes and consistent meter across stanzas.]";

      userPrompt = userPrompt.replace(
        /\[Write bold, unflinching, truth-revealing metrical rhymed verse dialogue featuring named characters and stage directions\..*?Maintain strict metrical and rhyme discipline\.\]/s,
        traditionalVerseInstructions
      );
    }

    userPrompt = userPrompt.replace(/\[\[narrative_context\]\]/g, narrativeContext);
    userPrompt = userPrompt.replace(/\[\[chunk\]\]/g, richContextBlock);
    userPrompt = userPrompt.replace(/\[\[ace_styles\]\]/g, getShuffledAceStyles());
    userPrompt = userPrompt.replace(/\[\[act_number\]\]/g, nextActNumber.toString());

    if (userPrompt.includes('[[hypotheses_block]]')) {
      userPrompt = userPrompt.replace(/\[\[hypotheses_block\]\]/g, hypothesisBlock);
    } else {
      userPrompt += `\n\n## ACCUMULATING STRUCTURAL TENSIONS\n${hypothesisBlock}`;
    }

    let stylisticEnforcement = "";
    if (selPrompt.name.includes("traditional") || selPrompt.name.includes("cantata") || selPrompt.name.includes("polyphony") || selPrompt.name.includes("opera")) {
      stylisticEnforcement = "\n\n--- CRITICAL SONIC DIRECTIVE ---\n" +
                             "The music pipeline is currently configured for an ACOUSTIC UN-AMPLIFIED RUN. " +
                             "You must strictly select tags representing acoustic, classical, vocal, or folk traditions. " +
                             "Do not use electronic, dark, synth, or industrial tags under any circumstances.";
    } else {
      stylisticEnforcement = "\n\n--- CRITICAL SONIC DIRECTIVE ---\n" +
                             "The music pipeline is configured for a SYNTHESIZED DRAMATIC RUN. " +
                             "You are encouraged to leverage modern electronic, atmospheric, or heavy production textures (such as Darksynth, Industrial Techno, Ambient, or Trip Hop).";
    }
    userPrompt += stylisticEnforcement;

    const rawOutput = await generateText(selPrompt.system, userPrompt);
    const parsed = parseUnifiedOutput(rawOutput);

    const forecastLower = parsed.forecast.toLowerCase();
    const hasStructuredFormat = 
        forecastLower.includes("benchmark") && 
        forecastLower.includes("trigger condition") && 
        forecastLower.includes("expected vector");

    if (hasStructuredFormat) {
        console.log("✅ Forecast followed structured format");
    } else {
        console.log("⚠️ Forecast did NOT follow the structured Benchmark/Trigger/Vector format");
    }

    if (parsed.forecast && parsed.forecast.trim().length > 40) {
        forecastsProcessedThisRun++;
    }

    // Programmatic Voice Enforcement & Tag Sanitization
    let rawTagsString = (parsed.musicTags || "").replace(/[\[\]()]/g, ''); 
    let cleanTagsArray = rawTagsString
      .split(',')
      .map(t => t.trim())
      .filter(t => {
        if (!t) return false;
        if (/baritone|tenor|soprano|mezzo|vocals|male|female/i.test(t)) return false;
        return RAW_ACE_STYLES.some(style => style.toLowerCase() === t.toLowerCase());
      });

    if (cleanTagsArray.length === 0) {
      cleanTagsArray = ["Folk", "Americana", "Bluegrass"];
    }

    cleanTagsArray = cleanTagsArray.slice(0, 3);
    cleanTagsArray.push(assignedVoice);

    const safeMusicTagsString = cleanTagsArray.join(', ');
    console.log(`🎵 Sanitized Music Tags submitted to worker: "${safeMusicTagsString}"`);

    if (!noMemory) {
      if (parsed.narrative_synthesis && parsed.narrative_synthesis.trim().length > 50) {
          const appended = await updateNarrativeArc(domain, parsed.narrative_synthesis, parsed.forecast, cumulativeModel);
          if (appended) forecastsAppendedThisRun++;
          await fs.writeFile(MODEL_PATH, JSON.stringify(cumulativeModel, null, 2));
          console.log(`📖 Narrative arc updated for [${domain}]`);
      }
      await updateUnifiedDomainModel(domain, nextActNumber, folder, parsed, mergedHypotheses);
    } else {
      console.log(`🛡️ Stateless Running Active: Skipping database mutations for ${folder}`);
    }

    // Media Generation Dispatches
    let imgRes = { success: false, filename: '', engine: 'Skipped/Failed', markdown: '' };

    if (useGrokImagine) {
      imgRes = await runGrokImagine(parsed.image, slugify(title));
    } else if (useGeminiImage) {
      const creativePrompt = `${parsed.image || slugify(title)}, dramatic counterpoint layout, highly-detailed traditional theatrical framing`;
      imgRes = await executeImagePipeline(creativePrompt, slugify(title));
    } else {
      imgRes = await runImageGen(parsed.image);
    }
    if (!useGeminiImage) await freeComfyVRAM();

    let vidRes = useGeminiVideo
      ? await runGeminiVideo(parsed.t2v, slugify(title))
      : await runVideoGen(parsed.t2v, imgRes.filename, forceT2V);
    if (!useGeminiVideo) await freeComfyVRAM();

    const ttsRes = await runPoetryTTS(parsed.verse);
    await freeComfyVRAM();

const activeRefAudio = refAudioSetting ? await resolveReferenceAudio(refAudioSetting) : null;
    const finalDuration = parseInt(parsed.musicDuration, 10) || generationDuration;

    let audioRes;
    if (useGeminiAudio) {
      audioRes = await runGeminiAudio(safeMusicTagsString, parsed.musicLyrics, slugify(title));
    } else if (useYue) {
      audioRes = await runYueGen(safeMusicTagsString, parsed.musicLyrics, slugify(title), finalDuration, activeRefAudio);
    } else {
      audioRes = await runAceStepGen(safeMusicTagsString, parsed.musicLyrics, slugify(title), finalDuration, activeRefAudio);
    }
    if (!useGeminiAudio) await freeComfyVRAM();

// Assemble Score Embed Block for Markdown
    let scoreArtifactsMarkdown = '';
    if (audioRes && audioRes.abcScore) {
      const uniqueId = `score_${Date.now()}`;
      scoreArtifactsMarkdown = `
---

### Compositional Score & Interactive Notation

<div class="score-controls" style="margin-bottom: 1rem; display: flex; gap: 12px; flex-wrap: wrap; align-items: center;">
  ${audioRes.midiFilename ? `<a class="download-btn" href="/images/${audioRes.midiFilename}" download style="padding: 6px 14px; background: #24292e; color: #58a6ff; border: 1px solid #30363d; border-radius: 6px; text-decoration: none; font-size: 0.9em; font-weight: 500;">🎹 Download MIDI (.mid)</a>` : ''}
  ${audioRes.abcFilename ? `<a class="download-btn" href="/images/${audioRes.abcFilename}" download style="padding: 6px 14px; background: #24292e; color: #58a6ff; border: 1px solid #30363d; border-radius: 6px; text-decoration: none; font-size: 0.9em; font-weight: 500;">🎼 Download ABC Score (.abc)</a>` : ''}
  <span style="font-size: 0.8em; opacity: 0.65; margin-left: auto;">💡 Click anywhere on the score to scrub audio</span>
</div>

<!-- Scrollable Viewport with Dynamic Playhead Tracker Overlay -->
<div class="score-viewport-frame" style="position: relative; max-height: 640px; overflow-y: auto; overflow-x: hidden; border: 1px solid #30363d; border-radius: 8px; background: #ffffff; scroll-behavior: smooth;">
  <!-- Playhead Laser Indicator -->
  <div class="score-playhead-tracker" style="position: absolute; left: 0; right: 0; height: 3px; background: #e63946; box-shadow: 0 0 10px #e63946, 0 0 3px #ffffff; z-index: 100; pointer-events: none; display: none; transform: translateY(-50%);">
    <span style="position: absolute; right: 8px; top: -18px; font-size: 10px; font-weight: 700; color: #e63946; background: rgba(255,255,255,0.95); padding: 1px 5px; border-radius: 3px; border: 1px solid #e63946; text-transform: uppercase;">Playing</span>
  </div>

  <div class="abc-score-sheet" id="sheet-${uniqueId}" data-abc="${encodeURIComponent(audioRes.abcScore)}" style="background: #ffffff; color: #000000; padding: 16px; box-sizing: border-box; width: 100%; cursor: pointer;">
    <!-- Rendered by /score-renderer.js -->
  </div>
</div>

<details style="margin-top: 1rem;">
<summary style="cursor: pointer; opacity: 0.8;">View Raw ABC Notation Plan</summary>

\`\`\`plaintext
${audioRes.abcScore}
\`\`\`

</details>
`;
    }


    // Clean up raw audio intermediates
    const rawFlacDirScan = await fs.readdir(IMAGES_DIR);
    for (const file of rawFlacDirScan) {
      if (file.endsWith('.flac') || file.endsWith('.wav')) {
        await safeUnlink(path.join(IMAGES_DIR, file));
      }
    }

// Build Astro Markdown Post
    const postDate = new Date().toISOString();
    const frontMatter = [
      `title: ${JSON.stringify(`${title} - Transmuted Pass`)}`,
      `date: "${postDate}"`,
      `pubDate: "${postDate.split('T')[0]}"`,
      `author: ${JSON.stringify((useGrok ? 'Grok' : 'Gemini') + ' + Core Single Pass Pipeline')}`,
      `source: "thread"`,
      `domain: ${JSON.stringify(domain)}`,
      `act: ${nextActNumber}`
    ];

    if (imgRes.success) frontMatter.push(`image: "/images/${imgRes.filename}"`);
    if (vidRes.success) frontMatter.push(`video: "/images/${vidRes.filename}"`);

    const displayImagePrompt = parsed.image || '_No image prompt generated._';

    const markdownPost = `---
${frontMatter.join('\n')}
---

<script src="/chroma-drift.js" type="module"></script>
<script src="/score-renderer.js" type="module"></script>

## Navigation
- [Ongoing Narrative Arc](#ongoing-narrative-arc)
- [Semantic Architecture](#semantic-architecture)
- [Primary Poetic Artifact](#primary-poetic-artifact)
- [Kinetic Dynamic Video](#kinetic-dynamic-video)
- [Visual Anchor Representation](#visual-anchor-representation)
- [Generated Musical Score](#generated-musical-score)
- [Pipeline & Debug Analytics](#pipeline-and-debug-analytics)
---

${activeHypothesisPayload ? `
### Active Underlying Paradigm

> **Scriptorium Operational Parameter [${activeHypothesisMode}]:**
> ${activeHypothesisPayload.split('\n').join('\n> ')}

${parsed.hypothesisLimerick ? `
> **Paradigm Limerick Distillation:**
> ${parsed.hypothesisLimerick.split('\n').join('\n> ')}
` : ''}

---
` : ''}

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

${parsed.diagram ? `
---

## Semantic Architecture

${parsed.diagram}
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

${audioRes.refAudioMarkdown || ''}

<div class="score-lyrics-card" style="margin: 1.25rem 0; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 8px; padding: 1rem 1.25rem;">
  <p style="margin: 0 0 0.5rem 0; font-size: 0.9em; font-weight: 600; opacity: 0.85;">📜 Sung Lyrics & Vocal Realization:</p>
  <pre style="margin: 0; background: transparent; border: none; padding: 0; font-size: 0.88em; line-height: 1.5; max-height: 240px; overflow-y: auto;">${parsed.musicLyrics || '_No lyrical words configuration found._'}</pre>
</div>

##### Musical Score Vocal & Instrument Prompt Mapping
<blockquote>
<strong>Target Music Metadata Tags:</strong> <code>${safeMusicTagsString}</code><br>
<strong>Target Score Audio Duration:</strong> ${finalDuration} seconds<br>
<strong>Reference Anchor Conditioning:</strong> <code>${audioRes.refAudioName || 'None (Unconditioned)'}</code>
</blockquote>

${scoreArtifactsMarkdown}

---

<h2 id="pipeline-and-debug-analytics">Pipeline & Debug Analytics</h2>

<strong>Active Text Inference Core Platform:</strong> <code>${actualModelUsed}</code><br>
<strong>Style Context Profile:</strong> <code>${selPrompt.name}.json</code><br>
<strong>Image Asset Processing Worker:</strong> <code>${imgRes.engine || 'Skipped/Failed'}</code><br>
<strong>Video Asset Processing Worker:</strong> <code>${vidRes.engine || 'Skipped/Failed'}</code><br>
<strong>TTS Spoken Audio Worker:</strong> <code>${ttsRes.engine || 'Skipped/Failed'}</code><br>
<strong>Soundtrack Audio Score Worker:</strong> <code>${audioRes.engine || 'Skipped/Failed'}</code><br>
<strong>Soundtrack Reference Anchor:</strong> <code>${audioRes.refAudioName || 'None'}</code>

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

  console.log(`\n📊 Run complete — ${forecastsProcessedThisRun} processed | ${forecastsAppendedThisRun} appended | ${forecastsInjectedThisRun} injected.`);
}

main().catch(err => { console.error("Fatal pipeline loop exception:", err); process.exit(1); });
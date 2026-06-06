const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const { execFile } = require('child_process');
const util = require('util');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const execFileAsync = util.promisify(execFile);

// --- CONFIGURATION ---
const PROMPTS_DIR = path.join(__dirname, 'prompts-new');
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

// --- ACE-STEP 1.5 VALID GENRES ---
const RAW_ACE_STYLES = [
  "Acid House", "Acid Techno", "Afro House", "Afro Tech", "Afrobeats", "Alternative / Indie", "Alternative Rock", "Amapiano", "Ambient", "Ambient Techno", "Americana", "Andean Music", "Arrocha", "Axe", "Bachata", "Banda Music", "Bass House", "Bassline", "Big Room", "Bluegrass", "Blues", "Bolero", "Bossa Nova", "Bounce", "Brazilian Bass", "Brazilian Popular Music", "Breakbeat", "Breakcore", "Brega", "Brega Funk", "Brega Funk (Recife)", "Brostep", "Celtic Folk", "Children", "Chillhop", "Chillstep", "Chillwave", "Choro", "City Pop", "Classical", "Coldwave", "Corridos", "Country", "Coupe Decale", "Cuarteto", "Cumbia", "Cyber-Punk", "Cyberpunk", "Dance", "Dancehall", "Dark Ambient", "Darkstep", "Darksynth", "Darkwave", "Deep House", "Dembow", "Detroit Techno", "Disco", "Downtempo", "Dream Pop", "Drill Funk", "Drone", "Drum and Bass", "Drumstep", "Dubstep", "Dubstep (Deep)", "Electro", "Electro House", "Electro-Funk", "Electro-Jazz", "Electro-Swing", "Electroacoustic", "Electroclash", "Electronic", "Electronica", "Electropop", "Emocore", "Eurobeat", "Eurodance", "Experimental", "Experimental Electronic", "Fado", "Flamenco / Bulerias", "Folk", "Forro", "Forró Eletrônico", "French House", "Funk", "Future Bass", "Future Funk", "Future Garage", "Future Rave", "Futurepop", "G-House", "Gabber", "Glitch", "Glitch Hop", "Goa Trance", "Gospel / Religious", "Gothic", "Gqom", "Grime", "Grunge", "Guarania", "Hands Up", "Hard Rock", "Hardcore", "Hardstyle", "Hardtechno", "Heavy Metal", "Highlife", "Hip Hop / Rap", "House", "Hybrid Trap", "Hyperpop", "IDM", "Indie Folk", "Industrial", "Industrial Techno", "Instrumental", "International Funk", "Irish Folk", "Italo Disco", "J-Pop / J-Rock", "Jazz", "Jersey Club", "Jovem Guarda", "Juke / Footwork", "Jungle", "K-Pop", "Kizomba", "Kuduro", "Liquid Drum and Bass", "Liquid Funk", "Lo-Fi Hip Hop", "Lofi House", "Mambo", "Marches / Anthems", "Mariachi", "Math Rock", "Melodic Techno", "Merengue", "Metal", "Micro House", "Microhouse", "Midwest Emo", "Minimal / Deep Tech", "Minimal Techno", "Moombahton", "Nativist Folk", "Neurofunk", "New Age", "New Retro Wave", "New Wave", "Nu-Funk", "Old Guard Samba", "Organic House", "Pagode", "Pagotrap", "Philly Soul", "Phonk", "Phonk House", "Piseiro", "Pop", "Pop Rock", "Post-Hardcore", "Post-Punk", "Post-Rock", "Power-Pop", "Progressive Electronic", "Progressive House", "Progressive Rock", "Psychedelia", "Psytrance", "Punk Rap / Emo Rap", "Punk Rock", "R&B", "Ragga Jungle", "Ranchera", "Rave", "Reggae", "Reggaeton", "Regional", "Retrowave", "Riddim", "Rock", "Rock and Roll", "Rockabilly", "Romantic", "Salsa", "Samba", "Samba Enredo", "Schranz", "Sertanejo", "Sertanejo Universitário", "Shoegaze", "Ska", "Soft Rock", "Soul", "Soulful House", "Surf Music", "Synthpop", "Synthwave", "Synthwave-Darkwave", "Tango", "Tech House", "Tech Trance", "Tech-Funk", "Techno", "Technopop", "Trance", "Trap", "Trip Hop", "Trova", "Turreo RKT", "UK Drill", "UK Garage", "Uplifting Trance", "Vallenato", "Vapor-Trap", "Vaporwave", "Vocal Trance", "Wave", "World Music", "Xote", "Zamba", "Zouk", "Zouk Bass"
];

const EXCLUDED_STYLES = [
  "Amapiano", "Arrocha", "Axe", "Banda Music", "Brega", "Brega Funk", "Brega Funk (Recife)", 
  "Children", "Choro", "Corridos", "Coupe Decale", "Cuarteto", "Forro", "Forró Eletrônico", 
  "Gabber", "Gospel / Religious", "Gqom", "Guarania", "Hands Up", "Jovem Guarda", "Kizomba", 
  "Kuduro", "Marches / Anthems", "Mariachi", "Nativist Folk", "Old Guard Samba", "Pagode", 
  "Pagotrap", "Piseiro", "Ranchera", "Regional", "Samba Enredo", "Schranz", "Sertanejo", 
  "Sertanejo Universitário", "Turreo RKT", "Vallenato", "Xote", "Zamba", "Zouk", "Zouk Bass"
];

const APPROVED_STYLES_STRING = RAW_ACE_STYLES
    .filter(style => !EXCLUDED_STYLES.includes(style))
    .join(', ');

// --- FLAGS ---
const args = process.argv.slice(2);
const useGrok = args.includes('--grok');
const forceT2V = args.includes('--t2v'); 
const useHunyuan = args.includes('--hunyuan');
const forceOmniGen = args.includes('--omnigen');
const refineWithOmniGen = args.includes('--omnigen-refine');
const useErnie = args.includes('--ernie'); 
const useLens = args.includes('--lens'); 
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

async function freeComfyVRAM() {
    console.log("🧹 Telling ComfyUI to release VRAM...");
    try {
        await fetch('http://127.0.0.1:8188/free', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ unload_models: true, free_memory: true })
        });
    } catch (e) {
        console.warn("   ⚠️ Could not reach ComfyUI to clear VRAM.");
    }
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

// --- STRUCTURED RE-PARSER (ONE PASS) ---
function parseUnifiedOutput(text) {
  const sections = { verse: '', forecast: '', hypothesis: '', image: '', t2v: '', music: '' };
  let current = 'verse';
  
  text.split('\n').forEach(line => {
    const l = line.trim().toLowerCase();
    
    if (l.match(/^(#+|\*\*|__|-)*\s*(image|visual)( generation)? prompt/i)) {
        current = 'image';
    } else if (l.match(/^(#+|\*\*|__|-)*\s*(t2v|text[- ]to[- ]video|video)( generation)? prompt/i)) {
        current = 't2v';
    } else if (l.match(/^(#+|\*\*|__|-)*\s*(music|audio|song|soundtrack)( generation)? prompt/i)) {
        current = 'music';
    } else if (l.match(/^(#+|\*\*|__|-)*\s*forecast/i)) {
        current = 'forecast';
    } else if (l.match(/^(#+|\*\*|__|-)*\s*hypothesis/i)) {
        current = 'hypothesis';
    } else if (l.match(/^(#+|\*\*|__|-)*\s*(verse|poem|poetry|spoken text|reading|dramatic verse)/i)) {
        current = 'verse';
    } else if (sections[current] !== undefined) {
        sections[current] += line + '\n';
    }
  });

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
      if (tagArray.length > 0 && !RAW_ACE_STYLES.includes(tagArray[0])) {
          tagArray[0] = "Electronic"; 
      }
      tags = tagArray.join(', ');
  }

  const durMatch = metaText.match(/DURATION:\s*(\d+)/i);
  if (durMatch) duration = durMatch[1].trim();

  return {
    verse: cleanVerseText(sections.verse),
    forecast: sections.forecast.trim(),
    hypothesis: sections.hypothesis.trim(),
    image: sections.image.trim(),
    t2v: sections.t2v.trim(), 
    musicTags: tags,
    musicDuration: duration,
    musicLyrics: lyrics.replace(/[*_#`]/g, '').trim()
  };
}

async function generateText(system, user) {
  const maxChars = useGrok ? MAX_CHARS_GROK : MAX_CHARS_GEMINI;
  const truncatedUser = user.length > maxChars ? user.substring(0, maxChars) + '\n\n[Truncated]' : user;

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
    if (!res.ok) throw new Error(`Grok API error: ${await res.text()}`);
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
        console.warn(`   ⚠️ ${modelName} pass failed, moving to secondary wrapper.`);
      }
    }
  }
  throw new Error("All text generation attempts failed");
}

// ==========================================================
// --- MEDIA GENERATION METHODS (PRESERVED FROM V3) ---
// ==========================================================
async function runGeminiImage(prompt, slug) {
   try {
        const imageModel = genAI.getGenerativeModel({ model: "gemini-3.1-flash-image-preview" });
        const verticalPrompt = `${prompt || 'Abstract surreal composition'} -- This image must be generated in a vertical 9:16 aspect ratio.`;
        const result = await imageModel.generateContent(verticalPrompt);
        const imagePart = (result?.response?.candidates?.[0]?.content?.parts || []).find(p => p.inlineData);
        if (imagePart) {
            const finalFilename = `gemini_img_${slug}_${Date.now()}.png`;
            await fs.writeFile(path.join(IMAGES_DIR, finalFilename), Buffer.from(imagePart.inlineData.data, 'base64'));
            return { success: true, filename: finalFilename, engine: "Gemini 3.1 Flash Image", markdown: `<p><img src="/images/${finalFilename}" style="max-width:100%; border-radius:8px;" /></p>` };
        }
    } catch (e) { console.error(`❌ Gemini Image generation failed: ${e.message}`); }
    return { success: false, markdown: '' };
}

async function runGeminiVideo(prompt, slug) {
    const API_KEY = process.env.GEMINI_API_KEY1;
    try {
        const startResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning?key=${API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ "instances": [{ "prompt": prompt || "Cinematic video" }], "parameters": { "aspectRatio": "9:16" } })
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
    } catch (e) { console.error(`❌ Gemini Video Error: ${e.message}`); }
    return { success: false, markdown: '' };
}

async function runImageGen(prompt) {
  const stateFile = path.join(os.tmpdir(), `state-${Date.now()}.json`);
  try {
    await fs.writeFile('prompt.txt', prompt || 'Abstract composition', 'utf8');
    let runnerArgs = refineWithOmniGen ? ['run_omnigen_i2i.js'] : (forceOmniGen ? ['run_omnigen_t2i.js'] : (useErnie ? ['run_ernie.js'] : (useLens ? ['run_lens.js'] : ['run_z_turbo.js'])));
    
    // Handle fast anchor logic if refining
    if (refineWithOmniGen) {
        await execFileAsync('bun', ['run_z_turbo.js', '--state-file', 'anchor_state.json']);
    }
    
    await execFileAsync('bun', [...runnerArgs, '--state-file', stateFile]);
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    return { success: true, filename: state.filename, engine: runnerArgs[0], markdown: `<p><img src="/images/${state.filename}" style="max-width:100%; border-radius:8px;" /></p>` };
  } catch (e) { console.error(`Image generation failed: ${e.message}`); return { success: false, markdown: '' }; }
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
    return { success: true, filename, engine: useHunyuan ? "Hunyuan" : "LTX-Video", markdown: `\n<video controls src="/images/${filename}" style="max-width:100%;" loop muted></video>\n` };
  } catch (e) { console.error(`Video generation failed: ${e.message}`); return { success: false, markdown: '' }; }
}

async function runPoetryTTS(poemText) {
    const stateFile = path.join(os.tmpdir(), `tts-state-${Date.now()}.json`);
    try {
        await fs.writeFile('temp_poem.txt', poemText || 'Silence.', 'utf8');
        let runnerArgs = useOmniVoice ? ['run_omnivoice_clone.js'] : (useVoxCPM2 ? ['run_voxcpm2.js'] : ['run_kokoro_tts.js']);
        await execFileAsync('bun', [...runnerArgs, '--state-file', stateFile, '--prompt-file', 'temp_poem.txt']);
        const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
        
        const finalOpusFilename = state.filename.replace(/\.(flac|wav)$/, '.opus');
        await execFileAsync('ffmpeg', ['-y', '-i', state.savedFilePath, '-c:a', 'libopus', '-b:a', '128k', path.join(IMAGES_DIR, finalOpusFilename)]);
        return { success: true, filename: finalOpusFilename, engine: runnerArgs[0], markdown: `\n<audio controls src="/images/${finalOpusFilename}"></audio>\n` };
    } catch (e) { console.error(`TTS generation failed: ${e.message}`); return { success: false, markdown: '' }; }
}

async function runAceStepGen(tags, lyrics, slug, duration) {
    const stateFile = path.join(os.tmpdir(), `acestep-state-${Date.now()}.json`);
    try {
        await execFileAsync('bun', ['run_acestep.js', '--state-file', stateFile, '--tags', tags, '--lyrics', lyrics, '--duration', duration.toString()]);
        const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
        const opusFilename = `acestep_${slug}_${Date.now()}.opus`;
        await execFileAsync('ffmpeg', ['-y', '-i', state.savedFilePath, '-af', `afade=t=out:st=${Math.max(0, duration - 5)}:d=5`, '-c:a', 'libopus', '-b:a', '128k', path.join(IMAGES_DIR, opusFilename)]);
        return { success: true, filename: opusFilename, engine: "ACE-Step 1.5", markdown: `\n<audio controls src="/images/${opusFilename}"></audio>\n` };
    } catch (e) { console.error(`ACE-Step Error: ${e.message}`); return { success: false, markdown: '' }; }
}

// ==========================================================
// --- CORE UNIFIED RETRIEVAL PIPELINE LOOP ---
// ==========================================================
async function updateUnifiedDomainModel(domain, structuralAnalysis, threadFolder, nextActNumber, parsedVerse) {
  let model = { lastUpdated: new Date().toISOString(), summary: "", recurringPatterns: [], domainThemes: {}, dramaticPlays: {} };
  try {
    model = JSON.parse(await fs.readFile(MODEL_PATH, 'utf8'));
  } catch (e) { console.log("   🆕 Instantiating clean cumulative memory map."); }

  if (!model.dramaticPlays) model.dramaticPlays = {};
  if (!model.dramaticPlays[domain]) model.dramaticPlays[domain] = [];

  // Update act array inside our single structured history tracker
  model.dramaticPlays[domain].push({
    thread: threadFolder,
    act: nextActNumber,
    timestamp: new Date().toISOString(),
    excerptSnapshot: parsedVerse.substring(0, 400)
  });

  // Basic neutral fallback distillation mapping (Can be extended with Grok JSON request)
  model.summary = `Processed act sequence down into ${domain} cycle from node block: ${threadFolder}`;
  model.lastUpdated = new Date().toISOString();
  
  await fs.writeFile(MODEL_PATH, JSON.stringify(model, null, 2) + '\n');
  console.log(`   📈 Tracked domain state down to model tracker [Act ${nextActNumber}]`);
}

async function main() {
  await Promise.all([fs.mkdir(POSTS_DIR, { recursive: true }), fs.mkdir(IMAGES_DIR, { recursive: true })]);

  const prompts = await loadPrompts();
  if (prompts.length === 0) throw new Error("No valid prompt templates resolved.");

  let promptIndex = 0;
  try {
      const stateData = JSON.parse(await fs.readFile(PROMPT_STATE_FILE, 'utf8'));
      promptIndex = (Number(stateData.lastIndex) || 0) + 1;
  } catch (e) {}
  if (promptIndex >= prompts.length || isNaN(promptIndex)) promptIndex = 0;
  const selPrompt = prompts[promptIndex];
  await fs.writeFile(PROMPT_STATE_FILE, JSON.stringify({ lastIndex: promptIndex }));
  
  console.log(`\n📄 Active prompt context mapping: ${selPrompt.name} [Art Mode: ${selPrompt.artisticMode}]`);

  const allFolders = await fs.readdir(X_DIR);
  const threadFolders = allFolders.filter(f => /^t\d+$/.test(f)).sort();
  const toProcess = targetThread ? threadFolders.filter(f => f === targetThread) : threadFolders;

  for (const folder of toProcess) {
    console.log(`\n--- Single Pass Processing Cycle: ${folder} ---`);
    let payload;
    try { 
        payload = JSON.parse(await fs.readFile(path.join(X_DIR, folder, 'payload.json'), 'utf8')); 
    } catch (e) { continue; }

    const title = payload.title || folder.toUpperCase();
    let richContextBlock = `THEMATIC SUMMARY:\n${payload.grok_poem || ''}\n\nRAW SOURCES TO TRANSMUTE:\n`;
    (payload.sources || []).forEach((src, idx) => {
        richContextBlock += `\n--- SOURCE ${idx + 1} ---\nURL: ${src.url}\nTEXT:\n${src.rich_text || src.description_short}\n`;
    });

    // ==========================================================
    // --- STEP 1: PRE-INFERENCE DOMAIN DETECTION & ACT LOOKUP ---
    // ==========================================================
    let domain = "technological";
    const lowerSummary = richContextBlock.toLowerCase();
    if (lowerSummary.includes("quantum") || lowerSummary.includes("galaxy") || lowerSummary.includes("science")) domain = "scientific";
    else if (lowerSummary.includes("art") || lowerSummary.includes("music") || lowerSummary.includes("baroque")) domain = "artistic";
    else if (lowerSummary.includes("trump") || lowerSummary.includes("election") || lowerSummary.includes("political")) domain = "political";

    let cumulativeModel = { dramaticPlays: {} };
    try {
        cumulativeModel = JSON.parse(await fs.readFile(MODEL_PATH, 'utf8'));
    } catch(e) {}
    
    // Explicit dynamic computation of next integer index
    const nextActNumber = (cumulativeModel.dramaticPlays?.[domain]?.length || 0) + 1;

    // ==========================================================
    // --- STEP 2: MONOLITHIC PROMPT SYNTHESIS ---
    // ==========================================================
    let userPrompt = selPrompt.chat.replace('[[chunk]]', richContextBlock);
    userPrompt = userPrompt.replace('[[ace_styles]]', APPROVED_STYLES_STRING);
    
    userPrompt += `\n\n--- CUMULATIVE CONTEXT ARCHIVE ---\n`;
    userPrompt += `DETECTED OPERATIONAL DOMAIN: ${domain.toUpperCase()}\n`;
    userPrompt += `HISTORICAL STREAM POSITION: Act ${nextActNumber - 1} logged.\n`;

    if (selPrompt.artisticMode === 'dramatic') {
        userPrompt += `\n\nCRITICAL SYSTEM REQUIREMENT:\nYou must return your primary creative work explicitly behind this header string:\n## DRAMATIC VERSE (Act ${nextActNumber})\nFollowed directly by verse line entries, staging notes, and character tags.`;
    } else {
        userPrompt += `\n\nCRITICAL SYSTEM REQUIREMENT:\nReturn your creative work behind a clean '## VERSE' block.`;
    }

    userPrompt += `\n\n## FORECAST\nProvide analytical insights.\n\n## HYPOTHESIS\nProvide a single concise falsifiable claim.\n\n## IMAGE PROMPT\nVisual parameters.\n\n## T2V PROMPT\nMotion mapping.`;

    // Execute single-pass generation
    const generated = await generateText(selPrompt.system, userPrompt);
    if (!generated) continue;

    // Parse out data variables from the shared blob context
    const parsed = parseUnifiedOutput(generated);

    // ==========================================================
    // --- STEP 3: UPDATE MEMORY LOGS & EXECUTE DOWNSTREAM MEDIA ---
    // ==========================================================
    await updateUnifiedDomainModel(domain, generated, folder, nextActNumber, parsed.verse);

    // 1. Image Spawner (Preserved down to your ComfyUI architecture toggles)
    let imgRes = useGrokImagine ? await runGrokImagine(parsed.image, slugify(title)) : (useGeminiImage ? await runGeminiImage(parsed.image, slugify(title)) : await runImageGen(parsed.image));
    if (!useGeminiImage) await freeComfyVRAM();

    // 2. Video Spawner
    let vidRes = useGeminiVideo ? await runGeminiVideo(parsed.t2v, slugify(title)) : await runVideoGen(parsed.t2v, imgRes.filename, forceT2V || useHunyuan);
    if (!useGeminiVideo) await freeComfyVRAM();

    // 3. Audio Reading (Passes resolved verse or text scene script automatically)
    const ttsRes = await runPoetryTTS(parsed.verse);
    await freeComfyVRAM();

    // 4. Background Suite Orchestrator
    const finalDuration = parseInt(parsed.musicDuration, 10) || generationDuration;
    let audioRes = useGeminiAudio ? await runGeminiAudio(parsed.musicTags, parsed.musicLyrics, slugify(title)) : await runAceStepGen(parsed.musicTags, parsed.musicLyrics, slugify(title), finalDuration);
    await freeComfyVRAM();

    // 5. Album Stitcher Wrapper (Unchanged)
    if (imgRes.success && audioRes.success) {
        try {
            await execFileAsync('ffmpeg', ['-loop', '1', '-framerate', '1', '-i', path.join(IMAGES_DIR, imgRes.filename), '-i', path.join(IMAGES_DIR, audioRes.filename), '-c:v', 'libx264', '-tune', 'stillimage', '-c:a', 'aac', '-b:a', '192k', '-pix_fmt', 'yuv420p', '-shortest', '-y', path.join(IMAGES_DIR, `x_ready_music_${slugify(title)}_${Date.now()}.mp4`)]);
        } catch (e) { console.error(`Stitching error: ${e.message}`); }
    }

    // ==========================================================
    // --- STEP 4: WRITE UNIFIED CLEAN MARKDOWN ENTRY ---
    // ==========================================================
    const frontMatter = [
        `title: "${title} – Transmuted Cycle"`,
        `author: "${useGrok ? 'Grok' : 'Gemini'} + One-Pass Structural Engine"`,
        `domain: "${domain}"`,
        `act: ${nextActNumber}`
    ];
    if (imgRes.success) frontMatter.push(`image: "/images/${imgRes.filename}"`);
    if (vidRes.success) frontMatter.push(`video: "/images/${vidRes.filename}"`);

    const markdownOutput = `---
${frontMatter.join('\n')}
---

## Contents
- [Creative Verse](#creative-verse)
- [System Forecast](#system-forecast)
- [Falsifiable Structural Hypothesis](#falsifiable-structural-hypothesis)
- [Kinetic Video Node](#kinetic-video-node)
- [Asset Architecture](#asset-architecture)

---

### Creative Verse {#creative-verse}
${parsed.verse || '_Creative compilation generation skipped._'}

${ttsRes.markdown || ''}

---

## System Forecast {#system-forecast}
${parsed.forecast || '_Analytical forecast metrics skipped._'}

## Falsifiable Structural Hypothesis {#falsifiable-structural-hypothesis}
> ${parsed.hypothesis || '_Falsifiable assertion statement skipped._'}

---

### Kinetic Video Node {#kinetic-video-node}
${vidRes.markdown || '_Kinetic tracking engine rendering skipped._'}

---

### Asset Architecture {#asset-architecture}
<strong>Operational Core:</strong> ${actualModelUsed}<br>
<strong>Style Context Profile:</strong> ${selPrompt.name}<br>
<strong>Sound Suite Profile:</strong> ${audioRes.engine || 'Skipped'}

#### Background Score Lyrics Configuration
<pre>${parsed.musicLyrics}</pre>
`;

    const finalSlug = `${slugify(title).substring(0, 40)}-${folder}-${Date.now()}.md`;
    await fs.writeFile(path.join(POSTS_DIR, finalSlug), markdownOutput);
    console.log(`💾 Post successfully saved to core system disk: ${finalSlug}`);
  }
}

main().catch(err => { console.error("Fatal exception inside script engine loop:", err); process.exit(1); });
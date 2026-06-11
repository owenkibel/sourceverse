const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const { execFile } = require('child_process');
const util = require('util');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const execFileAsync = util.promisify(execFile);

// --- CONFIGURATION MAPS ---
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

const APPROVED_STYLES_STRING = RAW_ACE_STYLES
    .filter(style => !EXCLUDED_STYLES.includes(style))
    .join(', ');

// --- CLI FLAGS ---
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
      if (tagArray.length > 0) {
          tags = tagArray.join(', ');
      }
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
    let runnerArgs = refineWithOmniGen ? ['run_omnigen_i2i.js'] : (forceOmniGen ? ['run_omnigen_t2i.js'] : (useErnie ? ['run_ernie.js'] : (useLens ? ['run_lens.js'] : ['run_z_turbo.js'])));
    
    if (refineWithOmniGen) {
        await execFileAsync('bun', ['run_z_turbo.js', '--state-file', 'anchor_state.json']);
    }
    
    await execFileAsync('bun', [...runnerArgs, '--state-file', stateFile]);
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    const finalFilename = state.filename;

    return { 
      success: true, 
      filename: finalFilename, 
      engine: runnerArgs[0] === 'run_lens.js' ? 'Lens' : (runnerArgs[0] === 'run_z_turbo.js' ? 'Z-Turbo' : 'OmniGen2'), 
      markdown: `<p><img src="/images/${finalFilename}" style="max-width:100%; border-radius:8px;" alt="Visual Artifact" /></p>` 
    };
  } catch (e) { console.error(`Local Image asset tracking worker failed: ${e.message}`); return { success: false, markdown: '' }; }
  finally { await safeUnlink(stateFile); await safeUnlink('prompt.txt'); }
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
async function updateUnifiedDomainModel(domain, folder, nextActNumber, parsed) {
  let model = { lastUpdated: new Date().toISOString(), summary: "", recurringPatterns: [], domainThemes: {}, dramaticPlays: {}, predictionHistory: [] };
  try {
    model = JSON.parse(await fs.readFile(MODEL_PATH, 'utf8'));
  } catch (e) { console.log("   🆕 Instantiating brand new structural history tracker mapping."); }

  if (!model.dramaticPlays) model.dramaticPlays = {};
  if (!model.dramaticPlays[domain]) model.dramaticPlays[domain] = [];
  if (!model.predictionHistory) model.predictionHistory = [];

  model.dramaticPlays[domain].push({
    thread: folder,
    act: nextActNumber,
    timestamp: new Date().toISOString(),
    excerptSnapshot: parsed.verse.substring(0, 400)
  });

  model.predictionHistory.unshift({
    thread: folder,
    date: new Date().toISOString(),
    forecast: parsed.forecast.substring(0, 500),
    hypothesis: parsed.hypothesis.substring(0, 300)
  });

  if (model.predictionHistory.length > 25) model.predictionHistory.pop();

  model.summary = `Successfully tracking domain loop [${domain.toUpperCase()}] down into stream act position: ${nextActNumber}`;
  model.lastUpdated = new Date().toISOString();
  
  await fs.writeFile(MODEL_PATH, JSON.stringify(model, null, 2) + '\n');
}

async function main() {
  await Promise.all([fs.mkdir(POSTS_DIR, { recursive: true }), fs.mkdir(IMAGES_DIR, { recursive: true })]);

  const prompts = await loadPrompts();
  if (prompts.length === 0) throw new Error("No files discovered inside prompts-new directory mapping.");

  let promptIndex = 0;
  try {
      const stateData = JSON.parse(await fs.readFile(PROMPT_STATE_FILE, 'utf8'));
      promptIndex = (Number(stateData.lastIndex) || 0) + 1;
  } catch (e) {}
  if (promptIndex >= prompts.length || isNaN(promptIndex)) promptIndex = 0;
  const selPrompt = prompts[promptIndex];
  await fs.writeFile(PROMPT_STATE_FILE, JSON.stringify({ lastIndex: promptIndex }));
  
  console.log(`\n📄 Active contextual prompt style: ${selPrompt.name} [Artistic Mode: ${selPrompt.artisticMode}]`);

  const allFolders = await fs.readdir(X_DIR);
  const threadFolders = allFolders.filter(f => /^t\d+$/.test(f)).sort();
  const toProcess = targetThread ? threadFolders.filter(f => f === targetThread) : threadFolders;

  for (const folder of toProcess) {
    console.log(`\n--- Production Layer Execution Node: ${folder} ---`);
    let payload;
    try { 
        payload = JSON.parse(await fs.readFile(path.join(X_DIR, folder, 'payload.json'), 'utf8')); 
    } catch (e) { continue; }

    const title = payload.title || folder.toUpperCase();
    let richContextBlock = `THEMATIC SUMMARY:\n${payload.grok_poem || ''}\n\nRAW SOURCES TO TRANSMUTE:\n`;
    (payload.sources || []).forEach((src, idx) => {
        richContextBlock += `\n--- SOURCE ${idx + 1} ---\nURL: ${src.url}\nDATA ANALYSIS:\n${src.rich_text || src.description_short}\n`;
    });

    let domain = "technological";
    const lowerSummary = richContextBlock.toLowerCase();
    if (lowerSummary.includes("quantum") || lowerSummary.includes("galaxy") || lowerSummary.includes("science")) domain = "scientific";
    else if (lowerSummary.includes("art") || lowerSummary.includes("music") || lowerSummary.includes("baroque")) domain = "artistic";
    else if (lowerSummary.includes("trump") || lowerSummary.includes("election") || lowerSummary.includes("political")) domain = "political";

    let cumulativeModel = { dramaticPlays: {} };
    try {
        cumulativeModel = JSON.parse(await fs.readFile(MODEL_PATH, 'utf8'));
    } catch(e) {}
    
    const nextActNumber = (cumulativeModel.dramaticPlays?.[domain]?.length || 0) + 1;

    // Assemble unified single prompt structure
    let userPrompt = selPrompt.chat.replace('[[chunk]]', richContextBlock);
    userPrompt = userPrompt.replace('[[ace_styles]]', APPROVED_STYLES_STRING);
    
    userPrompt += `\n\n--- ARCHIVAL PIPELINE MEMORY FIELDS ---\n`;
    userPrompt += `TARGET SEGMENT DOMAIN: ${domain.toUpperCase()}\n`;
    userPrompt += `CURRENT SEQUENCE DEPTH FLAG: Act ${nextActNumber - 1} recorded inside current map structure.\n`;

    userPrompt += `\n\nCRITICAL MUSIC COMPOSITION REQUIREMENTS:\nInside your '## MUSIC PROMPT' section under the 'LYRICS:' field, you MUST segment the words explicitly using uppercase song arrangement brackets, such as: '[Verse 1]', '[Chorus]', '[Verse 2]', '[Chorus]', and '[Outro]'. If these are missing or stripped out, the generation engine outputs an instrumental. Lyrical words must follow the tag blocks on a new line immediately.`;

    if (selPrompt.artisticMode === 'dramatic') {
        userPrompt += `\n\nCRITICAL OUTPUT ENFORCEMENT RULES:\nYou must return your primary creative theater work explicitly using this block structure layout header:\n## DRAMATIC VERSE (Act ${nextActNumber})\nEnsure dialogue uses named uppercase roles and complies with metrical rhymed frameworks.`;
    } else {
        userPrompt += `\n\nCRITICAL OUTPUT ENFORCEMENT RULES:\nReturn your creative piece behind a transparent '## VERSE' block string markup loop.`;
    }

    userPrompt += `\n\n## FORECAST\nProvide concise projections matching the context variables.\n\n## HYPOTHESIS\nProvide a unique falsifiable assertion statement based on recurring motifs here.\n\n## IMAGE PROMPT\nVisual parameters layout.\n\n## T2V PROMPT\nMotion mapping tracking parameters.`;

    // Process single-pass text request
    const generated = await generateText(selPrompt.system, userPrompt);
    if (!generated) continue;

    const parsed = parseUnifiedOutput(generated);

    // Commit memory mappings
    await updateUnifiedDomainModel(domain, folder, nextActNumber, parsed);

    // 1. Image Generation Pass
    let imgRes = useGrokImagine ? await runGrokImagine(parsed.image, slugify(title)) : (useGeminiImage ? await runGeminiImage(parsed.image, slugify(title)) : await runImageGen(parsed.image));
    if (!useGeminiImage) await freeComfyVRAM();

    // 2. Video Generation Pass
    let vidRes = useGeminiVideo ? await runGeminiVideo(parsed.t2v, slugify(title)) : await runVideoGen(parsed.t2v, imgRes.filename, forceT2V || useHunyuan);
    if (!useGeminiVideo) await freeComfyVRAM();

    // 3. Audio Reading Pass (Kokoro Spoken Dialogue)
    const ttsRes = await runPoetryTTS(parsed.verse);
    await freeComfyVRAM();

    // 4. Background Soundtrack Generation Pass (ACE-Step / Heartmula)
    const finalDuration = parseInt(parsed.musicDuration, 10) || generationDuration;
    let audioRes = useGeminiAudio ? await runGeminiAudio(parsed.musicTags, parsed.musicLyrics, slugify(title)) : (useHeartmula ? await runAudioGen(parsed.musicTags, parsed.musicLyrics, slugify(title), 96) : await runAceStepGen(parsed.musicTags, parsed.musicLyrics, slugify(title), finalDuration));
    if (!useGeminiAudio) await freeComfyVRAM();

    // 5. MP4 Video Stitching Pipeline (Combines Image and Audio for Twitter compatibility)
    if (imgRes.success && audioRes.success) {
        try {
            await execFileAsync('ffmpeg', ['-loop', '1', '-framerate', '1', '-i', path.join(IMAGES_DIR, imgRes.filename), '-i', path.join(IMAGES_DIR, audioRes.filename), '-c:v', 'libx264', '-tune', 'stillimage', '-c:a', 'aac', '-b:a', '192k', '-pix_fmt', 'yuv420p', '-shortest', '-y', path.join(IMAGES_DIR, `x_ready_music_${slugify(title)}_${Date.now()}.mp4`)]);
        } catch (e) {}
    }

    // Post processing sweep to clear uncompressed intermediate flac/wav waveforms completely
    const rawFlacDirScan = await fs.readdir(IMAGES_DIR);
    for (const file of rawFlacDirScan) {
        if (file.endsWith('.flac') || file.endsWith('.wav')) {
            await safeUnlink(path.join(IMAGES_DIR, file));
        }
    }

 // ==========================================================
    // --- ASTRO BLOG OUTPUT CREATION AND ASSET EMBEDDING ---
    // ==========================================================
// 1. Capture high-precision UTC time for deterministic sorting
    const postDate = new Date().toISOString();

    // 2. Build Astro-aligned Frontmatter
    // JSON.stringify safely escapes arbitrary title characters (like colons or quotes)
    const frontMatter = [
        `title: ${JSON.stringify(`${title} – Transmuted Pass`)}`,
        `date: "${postDate}"`,
        `pubDate: "${postDate.split('T')[0]}"`,
        `author: ${JSON.stringify((useGrok ? 'Grok' : 'Gemini') + ' + Core Single Pass Pipeline')}`,
        `source: "thread"`,
        `domain: ${JSON.stringify(domain)}`,
        `act: ${nextActNumber}`
    ];
    
    // Aligned keys directly with your Astro schema layout definitions
    if (imgRes.success) frontMatter.push(`image: "/images/${imgRes.filename}"`);
    if (vidRes.success) frontMatter.push(`video: "/images/${vidRes.filename}"`);

    const markdownPost = `---
${frontMatter.join('\n')}
---

## Navigation Indexes
- [Primary Poetic Artifact](#primary-poetic-artifact)
- [Analytical Forecast Evaluation](#analytical-forecast-evaluation)
- [Falsifiable Structural Hypothesis](#falsifiable-structural-hypothesis)
- [Kinetic Dynamic Video](#kinetic-dynamic-video)
- [Visual Anchor Representation](#visual-anchor-representation)
- [Generated Musical Score](#generated-musical-score)
- [Pipeline & Debug Analytics](#pipeline-and-debug-analytics)

---

### Primary Poetic Artifact {#primary-poetic-artifact}
<div class="poetry-verse">
${parsed.verse || '_Poetic text generation unavailable._'}
</div>

${ttsRes.markdown || ''}

---

## Analytical Forecast Evaluation {#analytical-forecast-evaluation}
${parsed.forecast || '_Forward-looking metrics unavailable._'}

## Falsifiable Structural Hypothesis {#falsifiable-structural-hypothesis}
> ${parsed.hypothesis || '_Falsifiable claim assertion block skipped._'}

---

### Kinetic Dynamic Video {#kinetic-dynamic-video}
${vidRes.markdown || '_Kinetic video tracking element skipped._'}

##### Video Generation Prompt (Text-to-Video Engine)
<blockquote>
<strong>Target Prompt Parameters:</strong> ${parsed.t2v || '_No video prompt generated._'}
</blockquote>

---

### Visual Anchor Representation {#visual-anchor-representation}
${imgRes.markdown || '_Visual anchor asset rendering unavailable._'}

##### Image Generation Prompt (Visual Engine)
<blockquote>
<strong>Target Prompt Parameters:</strong> ${parsed.image || '_No image prompt generated._'}
</blockquote>

---

### Generated Musical Score {#generated-musical-score}
${audioRes.markdown || '_Generated background score audio embed is unavailable._'}

##### Musical Score Vocal & Instrument Prompt Mapping
<blockquote>
<strong>Target Music Metadata Tags:</strong> <code>${parsed.musicTags}</code><br>
<strong>Target Score Audio Duration:</strong> ${finalDuration} seconds
</blockquote>
<pre>${parsed.musicLyrics || '_No lyrical words configuration found._'}</pre>

---

### Pipeline & Debug Analytics {#pipeline-and-debug-analytics}
<strong>Active Text Inference Core Platform:</strong> <code>${actualModelUsed}</code><br>
<strong>Style Context Profile:</strong> <code>${selPrompt.name}.json</code><br>
<strong>Image Asset Processing Worker:</strong> <code>${imgRes.engine || 'Skipped/Failed'}</code><br>
<strong>Video Asset Processing Worker:</strong> <code>${vidRes.engine || 'Skipped/Failed'}</code><br>
<strong>TTS Spoken Audio Worker:</strong> <code>${ttsRes.engine || 'Skipped/Failed'}</code><br>
<strong>Soundtrack Audio Score Worker:</strong> <code>${audioRes.engine || 'Skipped/Failed'}</code>

<br>

### Complete Core Prompt Log
<details><summary>Expand Full Prompt Code Details Sent to Inference Engine</summary>

#### System Directive Context Profile
\`\`\`text
${selPrompt.system}
\`\`\`

#### Final Assembled Chat Prompt Payload
\`\`\`text
${userPrompt}
\`\`\`

</details>
`;

    // 3. Collision-Proof File Generation Sequence
    const baseSlug = `${slugify(title).substring(0, 40)}-${folder}-${Date.now()}`;
    let finalFilePath = path.join(POSTS_DIR, `${baseSlug}.md`);
    let counter = 1;

    while (true) {
        try {
            // Asynchronously probe path availability
            await fs.access(finalFilePath);
            // Path is busy; append counter suffix
            finalFilePath = path.join(POSTS_DIR, `${baseSlug}-${counter}.md`);
            counter++;
        } catch {
            // Path is clear to write
            break;
        }
    }

    // 4. Atomic Write Operation
    await fs.writeFile(finalFilePath, markdownPost, 'utf8');
    console.log(`💾 Build completed. Post synchronized cleanly with audio embed: ${path.basename(finalFilePath)}`);
    await freeComfyVRAM();
  }
}

main().catch(err => { console.error("Fatal pipeline loop exception:", err); process.exit(1); });
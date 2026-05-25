const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const { execFile } = require('child_process');
const util = require('util');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const execFileAsync = util.promisify(execFile);

// --- CONFIGURATION ---
const PROMPTS_DIR = path.join(__dirname, 'prompts');
const POSTS_DIR = 'posts';
const IMAGES_DIR = 'images';
const X_DIR = './x';
const PROMPT_STATE_FILE = path.join(__dirname, '.prompt_state.json');

// --- Watchdog Directories ---
const HEART_INBOX = '/home/owen/ai-projects/heartmula/inbox';
const HEART_OUTBOX = '/home/owen/ai-projects/heartmula/outbox';

// Change this line:
// const MODEL_GROK = "grok-4.20-non-reasoning";

// To this:
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
const useT2VPromptForI2V = args.includes('--t2v-prompt-for-i2v');   // ← NEW
const useHunyuan = args.includes('--hunyuan');
const forceOmniGen = args.includes('--omnigen');
// ... rest of flags
const refineWithOmniGen = args.includes('--omnigen-refine');
const useErnie = args.includes('--ernie'); // <-- ADD THIS LINE
const useHeartmula = args.includes('--heartmula');
const useOmniVoice = args.includes('--omnivoice');
const useVoxCPM2 = args.includes('--voxcpm2');

// ---> NEW: GEMINI API TOGGLES <---
const useGeminiImage = args.includes('--gemini-image');
const useGeminiAudio = args.includes('--gemini-audio');
const useGeminiVideo = args.includes('--gemini-video');

const useGrokImagine = args.includes('--grok-imagine');

let refAudioPath = null;
const refArg = args.find(a => a.startsWith('--ref-audio='));
if (refArg) refAudioPath = refArg.split('=')[1];

let actualModelUsed = "";
let generationDuration = 90; 
const durArg = args.find(a => a.startsWith('--duration='));
if (durArg) {
  generationDuration = parseInt(durArg.split('=')[1], 10) || 90;
}

let targetThread = null;
const threadArgIndex = args.findIndex(a => a.startsWith('--thread='));
if (threadArgIndex !== -1) {
  targetThread = args[threadArgIndex].split('=')[1].trim();
}

if (useGrok && !process.env.XAI_API_KEY) throw new Error("XAI_API_KEY missing for --grok");
if (!process.env.GEMINI_API_KEY1) throw new Error("GEMINI_API_KEY1 missing");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY1);

// --- UTILS ---
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
        console.log("   ✅ ComfyUI VRAM cleared.");
    } catch (e) {
        console.warn("   ⚠️ Could not reach ComfyUI to clear VRAM (it might not be running).");
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
    available.push({ name: path.basename(file, '.json'), system: repl(p.system), chat: repl(p.chat) });
  }
  return available;
}

function parseOutput(text) {
  const sections = { verse: '', image: '', i2v: '', t2v: '', music: '' };
  let current = 'verse';
  
  text.split('\n').forEach(line => {
    const l = line.trim().toLowerCase();
    
    if (l.match(/^(#+|\*\*|__|-)*\s*(image|visual)( generation)? prompt/i)) {
        current = 'image';
    } else if (l.match(/^(#+|\*\*|__|-)*\s*(i2v|image[- ]to[- ]video)( generation)? prompt/i)) {
        current = 'i2v';
    } else if (l.match(/^(#+|\*\*|__|-)*\s*(t2v|text[- ]to[- ]video)( generation)? prompt/i)) {
        current = 't2v';
    } else if (l.match(/^(#+|\*\*|__|-)*\s*(video)( generation)? prompt/i)) {
        current = 'i2v';
    } else if (l.match(/^(#+|\*\*|__|-)*\s*(music|audio|song|soundtrack)( generation)? prompt/i)) {
        current = 'music';
    } else if (l.match(/^(#+|\*\*|__|-)*\s*(verse|poem|poetry|spoken text|reading)/i)) {
        current = 'verse';
    } else if (sections[current] !== undefined) {
        sections[current] += line + '\n';
    }
  });

  let rawMusic = sections.music.trim();
  rawMusic = rawMusic.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '');

  let tags = "Electronic, driving beat, rich synths, melodic pulse";
  let duration = "128"; 
  let lyrics = "";
  
  // 2. Cleanly Split Metadata from Lyrics
  const lyricsSplit = rawMusic.split(/[*_#`]*LYRICS:[*_#`]*/i);
  let metaText = "";
  
  if (lyricsSplit.length > 1) {
      metaText = lyricsSplit[0];
      lyrics = lyricsSplit.slice(1).join('LYRICS:').trim(); 
  } else {
      // FIX: Hunt specifically for structural song parts, not just any random bracket!
      const structuralMatch = rawMusic.match(/\[\s*(Intro|Verse|Chorus|Outro|Bridge|Instrumental)/i);
      if (structuralMatch) {
          metaText = rawMusic.substring(0, structuralMatch.index);
          lyrics = rawMusic.substring(structuralMatch.index).trim();
      } else {
          metaText = rawMusic;
          lyrics = rawMusic;
      }
  }

  // 3. Extract TAGS from the isolated metaText
  let rawTags = "";
  const tagMatch = metaText.match(/TAGS:\s*([^\n]+)/i);
  
  if (tagMatch) {
      rawTags = tagMatch[1];
  } else {
      // FIX: If Grok forgot "TAGS:", grab the first line of metadata that isn't DURATION
      const lines = metaText.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.toLowerCase().includes('duration'));
      if (lines.length > 0) rawTags = lines[0];
  }

  if (rawTags) {
      rawTags = rawTags.replace(/[*_`#]/g, '').trim();
      let tagArray = rawTags.split(',').map(t => t.trim()).filter(t => t.length > 0);
      
      // Strip brackets from the primary genre in case Grok left them in
      let primaryTag = tagArray[0].replace(/\[|\]/g, '').trim();
      
      if (!RAW_ACE_STYLES.includes(primaryTag)) {
          console.warn(`   ⚠️ Invalid ACE-Step genre: "${primaryTag}". Falling back to "Electronic".`);
          tagArray[0] = "Electronic"; 
      } else {
          tagArray[0] = primaryTag; 
      }
      
      tags = tagArray.join(', '); 
  }

  const durMatch = metaText.match(/DURATION:\s*(\d+)/i);
  if (durMatch) {
      duration = durMatch[1].trim();
  }

  lyrics = lyrics
      .replace(/[*_#`]/g, '')           
      .replace(/[ \t]+\n/g, '\n')       
      .replace(/\s*(\[[a-zA-Z0-9\s]+\])\s*/g, '\n\n$1\n') 
      .replace(/\n{3,}/g, '\n\n')       
      .trim();
      
  return {
    verse: cleanVerseText(sections.verse),
    image: sections.image.trim(),
    i2v: sections.i2v.trim(), 
    t2v: sections.t2v.trim(), 
    musicTags: tags,
    musicDuration: duration,
    musicLyrics: lyrics
  };
}

async function generateText(system, user) {
  const maxChars = useGrok ? MAX_CHARS_GROK : MAX_CHARS_GEMINI;
  const truncatedUser = user.length > maxChars 
    ? user.substring(0, maxChars) + '\n\n[Input truncated for length]' 
    : user;

  if (useGrok) {
    console.log(`Generating with Grok (${MODEL_GROK}) via direct fetch`);
    
const payload = {
  model: MODEL_GROK,
  messages: [
    { role: "system", content: system },
    { role: "user", content: truncatedUser }
  ],
  temperature: 1.0
  // === NEW: Force non-reasoning mode on Grok 4.3 ===
  ,
  providerOptions: {
    xai: {
      reasoningEffort: "none"
    }
  }
};

    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.XAI_API_KEY}`
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Grok API error: ${res.status} ${errorText}`);
    }

    const data = await res.json();
    actualModelUsed = MODEL_GROK;
    return data.choices[0]?.message?.content || '';
  } else {
    console.log("Generating with Gemini");
    for (const modelName of ["gemini-3.1-pro-preview","gemini-3-flash-preview","gemini-3.1-flash-lite-preview"]) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName, generationConfig: { temperature: 1 } });
        const res = await model.generateContent(`${system}\n\n${truncatedUser}`);
        actualModelUsed = modelName;
        return res.response.text();
      } catch (e) {
        console.warn(`${modelName} failed: ${e.message}`);
      }
    }
  }
  throw new Error("All text generation attempts failed");
}

// ==========================================
// GEMINI NATIVE PIPELINES
// ==========================================

async function runGeminiImage(prompt, slug) {
    console.log(`\n🎨 Starting Gemini Image Generation (Flash Image)...`);
   try {
        const imageModel = genAI.getGenerativeModel({ model: "gemini-3.1-flash-image-preview" });
        
        // Enforce 9:16 vertical generation securely via prompt steering
        const verticalPrompt = `${prompt || 'Abstract surreal composition'} -- This image must be generated in a vertical 9:16 aspect ratio, portrait orientation.`;
        
        const result = await imageModel.generateContent(verticalPrompt);
        
        const parts = result?.response?.candidates?.[0]?.content?.parts || [];
        const imagePart = parts.find(p => p.inlineData);

        if (imagePart) {
            const base64Image = imagePart.inlineData.data;
            const mimeType = imagePart.inlineData.mimeType;
            const ext = mimeType.includes('png') ? 'png' : 'jpg';
            const finalFilename = `gemini_img_${slug}_${Date.now()}.${ext}`;
            const outputPath = path.join(IMAGES_DIR, finalFilename);
            
            await fs.writeFile(outputPath, Buffer.from(base64Image, 'base64'));
            console.log(`   ✅ Image successfully saved to ${finalFilename}`);
            
            const formattedHtml = `<a href="/images/${finalFilename}" target="_blank" title="Click to view full resolution">\n  <img src="/images/${finalFilename}" style="max-width: 100%; border-radius: 8px; cursor: zoom-in;" alt="Gemini Generated Image">\n</a>\n`;

            return { success: true, filename: finalFilename, markdown: formattedHtml, engine: "Gemini 3.1 Flash Image" };
        } else {
            throw new Error("No inlineData was found in the response.");
        }
    } catch (e) {
        console.error(`   ❌ Gemini Image generation failed: ${e.message}`);
        return { success: false, markdown: '' };
    }
}

async function runGeminiAudio(tags, lyrics, slug) {
    console.log(`\n🎼 Starting Gemini Audio Generation (Lyria Pro)...`);
    try {
        const musicModel = genAI.getGenerativeModel({ model: "lyria-3-pro-preview" });
        const songPrompt = `[Genre: ${tags}]\n\n${lyrics}`;
        
        const result = await musicModel.generateContent(songPrompt);
        const parts = result?.response?.candidates?.[0]?.content?.parts || [];
        const audioPart = parts.find(p => p.inlineData);

        if (audioPart) {
            const base64Audio = audioPart.inlineData.data;
            const rawMp3Path = path.join(os.tmpdir(), `gemini_audio_${Date.now()}.mp3`);
            await fs.writeFile(rawMp3Path, Buffer.from(base64Audio, 'base64'));
            
            const opusFilename = `gemini_audio_${slug}_${Date.now()}.opus`;
            const opusPath = path.join(IMAGES_DIR, opusFilename);

            console.log(`   🎵 Formatting to Opus for X.com compatibility...`);
            await execFileAsync('ffmpeg', [
                '-y', '-i', rawMp3Path, 
                '-c:a', 'libopus', '-b:a', '128k', 
                opusPath
            ]);
            await fs.unlink(rawMp3Path).catch(()=>{});

            return { 
                success: true, 
                filename: opusFilename,
                engine: "Lyria 3 Pro Preview",
                markdown: `\n<audio controls src="/images/${opusFilename}"></audio>\n` 
            };
        } else {
            throw new Error("No inlineData was found in the response.");
        }
    } catch (e) {
        console.error(`   ❌ Gemini Audio generation failed: ${e.message}`);
        return { success: false, markdown: '' };
    }
}

async function runGeminiVideo(prompt, slug) {
    console.log(`\n🎬 Starting Gemini Video Generation (Veo 3.1 LRO)...`);
    const API_KEY = process.env.GEMINI_API_KEY1;
    const MODEL_NAME = "veo-3.1-generate-preview";
    const startUrl = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:predictLongRunning?key=${API_KEY}`;
    
const payload = {
        "instances": [ { "prompt": prompt || "Cinematic wide shot, slow dynamic motion." } ],
        "parameters": { 
            "aspectRatio": "9:16" 
        }
    };
    
    try {
        const startResponse = await fetch(startUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const startData = await startResponse.json();
        if (startData.error) throw new Error(startData.error.message);

        const operationName = startData.name;
        console.log(`   🎟️ Operation Ticket: ${operationName}`);
        
        const pollUrl = `https://generativelanguage.googleapis.com/v1beta/${operationName}?key=${API_KEY}`;
        let isDone = false;
        let finalResponseData = null;

        process.stdout.write(`   ⏳ Polling server `);
        while (!isDone) {
            process.stdout.write(".");
            const pollResponse = await fetch(pollUrl);
            const pollData = await pollResponse.json();

            if (pollData.error) throw new Error(pollData.error.message);

            if (pollData.done === true) {
                finalResponseData = pollData.response;
                isDone = true;
                console.log(" DONE! 🎉");
            } else {
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
        }

        const videoUri = finalResponseData?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
        if (!videoUri) throw new Error("No secure URI found in final response.");

        console.log(`   ⬇️ Downloading MP4 from Google backend...`);
        const videoResponse = await fetch(videoUri, { headers: { 'x-goog-api-key': API_KEY } });
        if (!videoResponse.ok) throw new Error(`Download failed: ${videoResponse.statusText}`);

        const arrayBuffer = await videoResponse.arrayBuffer();
        const finalFilename = `gemini_vid_${slug}_${Date.now()}.mp4`;
        const outputPath = path.join(IMAGES_DIR, finalFilename);
        
        await fs.writeFile(outputPath, Buffer.from(arrayBuffer));
        console.log(`   ✅ Video successfully saved to ${finalFilename}`);

        return { 
            success: true, 
            filename: finalFilename, 
            engine: "Veo 3.1 Preview",
            markdown: `\n<p><video controls src="/images/${finalFilename}" style="max-width: 100%; border-radius: 8px;" loop muted></video></p>\n` 
        };

    } catch (e) {
        console.error(`\n   ❌ Gemini Video Error: ${e.message}`);
        return { success: false, markdown: '' };
    }
}

// ==========================================
// LOCAL COMFYUI PIPELINES
// ==========================================

async function runImageGen(prompt) {
  const stateFile = path.join(os.tmpdir(), `state-${Date.now()}.json`);
  try {
    await fs.writeFile('prompt.txt', prompt || 'Abstract surreal composition', 'utf8');

    console.log(`\n🎨 Starting Local Image Generation Phase...`);
    let anchorFilename = null; 

    if (refineWithOmniGen) {
        console.log(`[Stage 1/2] Generating fast anchor with Z-Turbo...`);
        const tempStateFile = 'anchor_state.json';
        await execFileAsync('bun', ['run_z_turbo.js', '--state-file', tempStateFile]);
        
        let anchorDataRaw = await fs.readFile(tempStateFile, 'utf8');
        const anchorData = JSON.parse(anchorDataRaw);
        const anchorPath = anchorData.savedFilePath;
        anchorFilename = anchorData.filename; 
        
        console.log(`[Stage 2/2] Up-ressing and refining with OmniGen2...`);
        await execFileAsync('bun', ['run_omnigen_i2i.js', '--input-image', anchorPath, '--state-file', stateFile]);
        await fs.unlink(tempStateFile).catch(() => {});
    } else if (forceOmniGen) {
        console.log(`Triggering direct Text-to-Image via OmniGen2...`);
        await execFileAsync('bun', ['run_omnigen_t2i.js', '--state-file', stateFile]);
    } else if (useErnie) {
        // <-- ADD THIS BLOCK
        console.log(`Triggering direct Text-to-Image via ERNIE-Image...`);
        await execFileAsync('bun', ['run_ernie.js', '--state-file', stateFile]);
    } else {
        console.log(`Triggering Text-to-Image via Z-Turbo...`);
        await execFileAsync('bun', ['run_z_turbo.js', '--state-file', stateFile]);
    }

    if (! (await fs.stat(stateFile).catch(() => false))) throw new Error("No state file – script failed");
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    const finalFilename = state.filename;

    let formattedHtml = '';
    if (anchorFilename) {
        formattedHtml += `#### Draft Anchor (Z-Turbo)\n`;
        formattedHtml += `<a href="/images/${anchorFilename}" target="_blank" title="Click to view full resolution">\n  <img src="/images/${anchorFilename}" style="max-width: 100%; border-radius: 8px; cursor: zoom-in;" alt="Z-Turbo Anchor Image">\n</a>\n<br><br>\n#### Refined Masterpiece (OmniGen2)\n`;
    }
    formattedHtml += `<a href="/images/${finalFilename}" target="_blank" title="Click to view full resolution">\n  <img src="/images/${finalFilename}" style="max-width: 100%; border-radius: 8px; cursor: zoom-in;" alt="Generated Final Image">\n</a>\n`;

    let engineName = "Z-Turbo";
    if (refineWithOmniGen) engineName = "Z-Turbo + OmniGen2 Refiner";
    else if (forceOmniGen) engineName = "OmniGen2 Direct";
    else if (useErnie) engineName = "ERNIE-Image"; // <-- ADD THIS LINE

    return { success: true, filename: finalFilename, markdown: formattedHtml, engine: engineName };
  } catch (e) {
    console.error(`Image generation failed: ${e.message}`);
    return { success: false, markdown: '' };
  } finally {
    await fs.unlink(stateFile).catch(() => {});
    await fs.unlink('prompt.txt').catch(() => {});
  }
}

async function runGrokImagine(imagePrompt, slug) {
  console.log(`\n🎨 Starting Grok Imagine Image Generation ($0.02)...`);
  const filename = `grok_imagine_${slug}_${Date.now()}.jpg`;
  const outputPath = path.join(IMAGES_DIR, filename);

  try {
    const response = await fetch('https://api.x.ai/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.XAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "grok-imagine-image",   // or "grok-imagine-image-quality" for higher fidelity
        prompt: `${imagePrompt} --ar 9:16 --style raw`, // vertical + raw style for consistency
        n: 1
      })
    });

    if (!response.ok) throw new Error(`Grok Imagine error: ${response.status}`);

    const data = await response.json();
    const imageUrl = data.data?.[0]?.url;   // xAI returns { data: [{ url: "..." }] }

    if (!imageUrl) throw new Error("No image URL in response");

    // Download and save
    const imgRes = await fetch(imageUrl);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    await fs.writeFile(outputPath, buffer);

    const formattedHtml = `<a href="/images/${filename}" target="_blank" title="Click to view full resolution">\n  <img src="/images/${filename}" style="max-width: 100%; border-radius: 8px; cursor: zoom-in;" alt="Grok Imagine Generated Image">\n</a>\n`;

    return {
      success: true,
      filename,
      markdown: formattedHtml,
      engine: "Grok Imagine"
    };
  } catch (e) {
    console.error(`   ❌ Grok Imagine failed: ${e.message}`);
    return { success: false, markdown: '' };
  }
}

async function runVideoGen(videoPrompt, anchorImageName, isT2V) {
  const stateFile = path.join(os.tmpdir(), `vid-state-${Date.now()}.json`);
  try {
    let runnerArgs;
    let engineName;

    // FORK: Route to Hunyuan if flag is present
    if (useHunyuan) {
        runnerArgs = ['run_fasthunyuan_t2v.js', '--state-file', stateFile, '--prompt', videoPrompt || 'Cinematic pan'];
        engineName = "FastHunyuan T2V";
    } else {
        // Default LTX-Video Pipeline
        runnerArgs = ['run_ltx_video.js', '--state-file', stateFile, '--prompt', videoPrompt || 'Cinematic pan'];
        engineName = "LTX-Video";
        if (isT2V) runnerArgs.push('--t2v');
        else if (anchorImageName) runnerArgs.push('--image', anchorImageName); 
    }

    const { stderr } = await execFileAsync('bun', runnerArgs);
    if (stderr && stderr.includes("Error:")) console.warn(`[${engineName}] ${stderr}`);

    if (! (await fs.stat(stateFile).catch(() => false))) throw new Error(`No state file – ${engineName} script failed`);
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    
    // Fallback to extract filename if path is absolute
    const filename = state.filename || path.basename(state.savedFilePath);

    return { 
        success: true, filename, engine: engineName,
        markdown: `\n<p><video controls src="/images/${filename}" style="max-width: 100%; border-radius: 8px;" loop muted></video></p>\n` 
    };
  } catch (e) {
    console.error(`Video generation failed: ${e.message}`);
    return { success: false, markdown: '' };
  } finally {
    await fs.unlink(stateFile).catch(() => {});
  }
}

async function runPoetryTTS(poemText) {
    const stateFile = path.join(os.tmpdir(), `tts-state-${Date.now()}.json`);
    const poemFile = 'temp_poem.txt';
    
    try {
        await fs.writeFile(poemFile, poemText || 'Silence.', 'utf8');

        if (useOmniVoice) {
            console.log(`\n🎙️ Starting OmniVoice Multi-Speaker TTS...`);
            await execFileAsync('bun', ['run_omnivoice_clone.js', '--state-file', stateFile, '--prompt-file', poemFile, '--ref-audio1', 'galaxy.wav', '--ref-audio2', 'progress.wav']);
        } else if (useVoxCPM2) {
            console.log(`\n🎙️ Starting VoxCPM2 Multi-Speaker TTS...`);
            await execFileAsync('bun', ['run_voxcpm2.js', '--state-file', stateFile, '--prompt-file', poemFile, '--ref-audio1', 'galaxy.wav', '--ref-audio2', 'progress.wav']);
        } else {
            console.log(`\n🎙️ Starting Kokoro TTS Poetry Reading...`);
            await execFileAsync('bun', ['run_kokoro_tts.js', '--state-file', stateFile, '--prompt-file', poemFile, '--voice', '🇺🇸 🚺 Bella 🔥']);
        }

        if (! (await fs.stat(stateFile).catch(() => false))) throw new Error("No state file – script failed");
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

        await fs.unlink(rawFlacPath).catch(() => {});

        let engineName = useOmniVoice ? "OmniVoice" : (useVoxCPM2 ? "VoxCPM2" : "Kokoro");

        return { 
            success: true, filename: finalOpusFilename, engine: engineName,
            markdown: `\n#### Spoken Verse\n<audio controls src="/images/${finalOpusFilename}"></audio>\n` 
        };
    } catch (e) {
        console.error(`TTS generation failed: ${e.message}`);
        return { success: false, markdown: '' };
    } finally {
        await fs.unlink(stateFile).catch(() => {});
        await fs.unlink(poemFile).catch(() => {});
    }
}

async function runAceStepGen(tags, lyrics, slug, duration) {
    const stateFile = path.join(os.tmpdir(), `acestep-state-${Date.now()}.json`);
    try {
        console.log(`\n🎼 Starting ACE-Step 1.5 Generation...`);
        await execFileAsync('bun', ['run_acestep.js', '--state-file', stateFile, '--tags', tags, '--lyrics', lyrics, '--duration', duration.toString()]);

        if (! (await fs.stat(stateFile).catch(() => false))) throw new Error("No state file – ACE-Step script failed");
        const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
        
        const rawFlacPath = state.savedFilePath;
        const opusFilename = `acestep_${slug}_${Date.now()}.opus`;
        const opusPath = path.join(IMAGES_DIR, opusFilename);

        const fadeStart = Math.max(0, duration - 5); 
        await execFileAsync('ffmpeg', ['-y', '-i', rawFlacPath, '-af', `afade=t=out:st=${fadeStart}:d=5`, '-c:a', 'libopus', '-b:a', '128k', opusPath]);
        await fs.unlink(rawFlacPath).catch(() => {});

        return { success: true, filename: opusFilename, engine: "ACE-Step 1.5", markdown: `\n<audio controls src="/images/${opusFilename}"></audio>\n` };
    } catch (e) {
        console.error(`\n   ❌ ACE-Step Error: ${e.message}`);
        return { success: false, markdown: '' };
    } finally {
        await fs.unlink(stateFile).catch(() => {});
    }
}

async function runAudioGen(tags, lyrics, slug, duration) {
    const baseName = `hm_${slug}_${Date.now()}`;
    const txtFile = path.join(HEART_INBOX, `${baseName}.txt`);
    const wavFile = path.join(HEART_OUTBOX, `${baseName}.wav`);
    const opusFile = path.join(IMAGES_DIR, `${baseName}.opus`); 
    const failedFile = path.join('/home/owen/ai-projects/heartmula/failed', `${baseName}.txt`);
    
    try {
        await fs.mkdir(HEART_INBOX, { recursive: true });
        await fs.mkdir(HEART_OUTBOX, { recursive: true });

        const finalOutput = `TAGS: ${tags}\nDURATION: ${duration}\n\n${lyrics}`;
        await fs.writeFile(txtFile, finalOutput);
        console.log(`\n🎼 Audio Request sent to Watchdog (${duration}s): ${baseName}.txt`);

        let attempts = 0;
        let successFound = false;
        let crashFound = false;

        process.stdout.write(`   ⏳ Waiting for Python Audio Server `);
        while (attempts < 120) {
            try {
                const stats = await fs.stat(wavFile);
                if (stats.size > 1000) { 
                    successFound = true;
                    await new Promise(r => setTimeout(r, 1500)); 
                    console.log(`\n   ✅ Found generated audio: ${baseName}.wav`);
                    break;
                }
            } catch (err) {}

            try {
                await fs.stat(failedFile);
                console.log(`\n   ❌ Watchdog moved request to 'failed' folder. Heartmula crashed.`);
                crashFound = true;
                break;
            } catch (err) {}

            process.stdout.write(".");
            await new Promise(r => setTimeout(r, 5000));
            attempts++;
        }

        if (crashFound || !successFound) return { success: false, markdown: '' }; 

        const fadeStart = Math.max(0, duration - 5); 
        await execFileAsync('ffmpeg', ['-y', '-i', wavFile, '-af', `afade=t=out:st=${fadeStart}:d=5`, '-c:a', 'libopus', '-b:a', '128k', opusFile]);
        await fs.unlink(wavFile).catch(() => {});
        
        return { success: true, filename: path.basename(opusFile), engine: "Heartmula", markdown: `\n<audio controls src="/images/${path.basename(opusFile)}"></audio>\n` };
    } catch (e) {
        console.error(`\n   ❌ Audio Generation Error: ${e.message}`);
        return { success: false, markdown: '' };
    }
}

async function updatePoliticalModel(modelUpdateContent, threadFolder, cleanForecast) {
  // modelUpdateContent = combined FORECAST + HYPOTHESIS from the new extraction
  const forecastText = modelUpdateContent;   // ← ONLY ONE declaration of forecastText

  const modelPath = 'cumulative_thread_model.json';
  let model = {
    lastUpdated: new Date().toISOString(),
    summary: "",
    recurringPatterns: [],
    domainThemes: { political: [], scientific: [], cultural: [], technological: [], philosophical: [], artistic: [] },
    actorForecasts: { democrats: [], republicans: [], bipartisan: [], media: [], public: [], scientific: [], cultural: [], technological: [] },
    predictionHistory: [],
    threadHistory: [],
    totalThreadsProcessed: 0
  };

  try {
    const existing = await fs.readFile(modelPath, 'utf8');
    model = JSON.parse(existing);
  } catch (e) {
    console.log("   🆕 Created new cumulative_thread_model.json");
  }

  // Clean the forecast text for the model summary (do NOT re-declare cleanForecast)
  const cleanedForecastForSummary = (forecastText || cleanForecast || "").replace(/^FORECAST:\s*/i, '').trim();

  model.threadHistory.unshift(threadFolder);
  model.totalThreadsProcessed++;

  // Aggressive pruning: keep only the most recent 25 predictions
  model.predictionHistory.unshift({
    thread: threadFolder,
    date: new Date().toISOString(),
    forecast: cleanedForecastForSummary.substring(0, 800),
    verseSnippet: cleanForecast.substring(0, 300)   // keep original verseExcerpt behavior
  });
  if (model.predictionHistory.length > 25) model.predictionHistory.pop();

  // === GROK-CALL UPGRADE: Intelligent, domain-aware distillation ===
  console.log(`   🤖 Running Grok distillation on ${model.totalThreadsProcessed} threads...`);
    try {
      const distillPrompt = `You are maintaining a cumulative model of recurring patterns, domain themes, and long-running hypotheses across ALL processed X threads (political, scientific, cultural, technological, philosophical, artistic).

Current thread (${threadFolder}) provides BOTH a FORECAST and a HYPOTHESIS section:

${forecastText}

Your task: Analyze the entire history + this thread's FORECAST and HYPOTHESIS and produce a refined, insightful update. Respect the domain-aware nature of the system. Do NOT force every thread into a partisan political frame.

Output **ONLY** valid JSON. No markdown, no explanations, no code blocks. Just the object.

{
  "recurringPatterns": ["short, precise, domain-agnostic patterns — aim for 15-35 strongest ones"],
  "domainThemes": {
    "political": ["short insights when relevant"],
    "scientific": ["short insights"],
    "cultural": ["short insights"],
    "technological": ["short insights"],
    "philosophical": ["short insights"],
    "artistic": ["short insights"]
  },
  "actorForecasts": {
    "democrats": ["short insights when relevant"],
    "republicans": ["short insights when relevant"],
    "bipartisan": ["short insights"],
    "media": ["short insights"],
    "public": ["short insights"],
    "scientific": ["short insights"],
    "cultural": ["short insights"],
    "technological": ["short insights"]
  }
}

Be neutral, evidence-based, creative, and concise. Prioritize genuine cross-domain insight over repetition. Let the detected DOMAIN guide the depth of political vs. scientific/cultural/technological framing. Use the HYPOTHESIS section to strengthen or refine long-running claims about human nature, institutional decay, technological displacement, etc.`;

      const res = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.XAI_API_KEY}`
        },
        body: JSON.stringify({
          model: MODEL_GROK,
          messages: [{ role: "user", content: distillPrompt }],
          temperature: 0.5,
          max_tokens: 1400
          // Force non-reasoning mode on Grok 4.3
          ,
          providerOptions: {
            xai: {
              reasoningEffort: "none"
            }
          }
        })
      });

      if (!res.ok) throw new Error(`Distillation error: ${res.status}`);

      const data = await res.json();
      let rawContent = (data.choices[0]?.message?.content || '{}').trim();

      // === BULLETPROOF JSON CLEANING (no backticks used) ===
      rawContent = rawContent
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .replace(/```/g, '')
        .trim();

      const distilled = JSON.parse(rawContent);

      // === SAFE MERGE (handles old models that lack domainThemes) ===
if (!distilled.recurringPatterns || !Array.isArray(distilled.recurringPatterns)) {
  distilled.recurringPatterns = [];
}

      // === SAFE MERGE (handles old models that lack domainThemes) ===
      if (distilled.recurringPatterns && Array.isArray(distilled.recurringPatterns)) {
        model.recurringPatterns = [...new Set([...model.recurringPatterns, ...distilled.recurringPatterns])].slice(0, 35);
      }

      if (!model.domainThemes) {
        model.domainThemes = { political: [], scientific: [], cultural: [], technological: [], philosophical: [], artistic: [] };
      }
      if (distilled.domainThemes) {
        Object.keys(distilled.domainThemes).forEach(key => {
          if (!model.domainThemes[key]) model.domainThemes[key] = [];
          if (Array.isArray(distilled.domainThemes[key])) {
            model.domainThemes[key] = [...new Set([...model.domainThemes[key], ...distilled.domainThemes[key]])].slice(0, 12);
          }
        });
      }

      if (!model.actorForecasts) {
        model.actorForecasts = { democrats: [], republicans: [], bipartisan: [], media: [], public: [], scientific: [], cultural: [], technological: [] };
      }
      if (distilled.actorForecasts) {
        Object.keys(distilled.actorForecasts).forEach(key => {
          if (!model.actorForecasts[key]) model.actorForecasts[key] = [];
          if (Array.isArray(distilled.actorForecasts[key])) {
            model.actorForecasts[key] = [...new Set([...model.actorForecasts[key], ...distilled.actorForecasts[key]])].slice(0, 12);
          }
        });
      }

      console.log(`   ✅ Distillation succeeded — domain-aware merge complete`);
    } catch (e) {
      console.warn(`   ⚠️ Grok distillation failed: ${e.message} — falling back to basic update`);
    }

  model.summary = `Processed ${model.totalThreadsProcessed} threads across domains. Latest from ${threadFolder}: ${cleanedForecastForSummary.substring(0, 160)}...`;

  await fs.writeFile(modelPath, JSON.stringify(model, null, 2) + '\n');
  console.log(`   📈 Updated cumulative_thread_model.json (${model.totalThreadsProcessed} threads | ${model.recurringPatterns.length} patterns)`);
}

async function main() {
  await Promise.all([fs.mkdir(POSTS_DIR, { recursive: true }), fs.mkdir(IMAGES_DIR, { recursive: true })]);

  const prompts = await loadPrompts();
  if (prompts.length === 0) throw new Error("No valid prompts found");

  let promptIndex = 0;
  try {
      const stateData = JSON.parse(await fs.readFile(PROMPT_STATE_FILE, 'utf8'));
      promptIndex = (Number(stateData.lastIndex) || 0) + 1;
  } catch (e) { 
      promptIndex = 0; 
  }

  if (promptIndex >= prompts.length || isNaN(promptIndex) || promptIndex < 0) promptIndex = 0;
  const selPrompt = prompts[promptIndex];
  await fs.writeFile(PROMPT_STATE_FILE, JSON.stringify({ lastIndex: promptIndex }));
  
  console.log(`\n📄 Selected prompt style: ${selPrompt.name} (Style ${promptIndex + 1} of ${prompts.length})`);

  const allFolders = await fs.readdir(X_DIR);
  const threadFolders = allFolders.filter(f => /^t\d+$/.test(f)).sort();

  const toProcess = targetThread ? threadFolders.filter(f => f === targetThread) : threadFolders;
  if (toProcess.length === 0) return console.log(`No matching thread folder found in ${X_DIR}`);

  for (const folder of toProcess) {
    console.log(`\n--- Processing ${folder} ---`);
    const payloadPath = path.join(X_DIR, folder, 'payload.json');

    let payload;
    try { 
        payload = JSON.parse(await fs.readFile(payloadPath, 'utf8')); 
    } catch (e) { 
        console.warn(`   ⚠️ Skipping ${folder}: payload.json missing.`);
        continue; 
    }

    const title = payload.title || folder.toUpperCase();
    let richContextBlock = `THEMATIC SUMMARY:\n${payload.grok_poem}\n\nRAW SOURCES TO TRANSMUTE:\n`;

    for (let i = 0; i < payload.sources.length; i++) {
        const source = payload.sources[i];
        richContextBlock += `\n--- SOURCE ${i + 1} ---\nURL: ${source.url}\nDESCRIPTION: ${source.description_short}\n`;
        if (source.rich_text) {
            const cleanText = source.rich_text.trim();
            richContextBlock += `FULL TEXT:\n${cleanText.length > 4000 ? cleanText.substring(0, 4000) + '\n\n[...Truncated...]' : cleanText}\n`;
        }
    }

    let userPrompt = `${selPrompt.chat.includes('[[chunk]]') ? selPrompt.chat.replace('[[chunk]]', richContextBlock) : selPrompt.chat + '\n\nAnalyze and transmute:\n' + richContextBlock}`;
    userPrompt = userPrompt.replace('[[ace_styles]]', APPROVED_STYLES_STRING);

        // === DOMAIN AUTO-DETECTION + CUMULATIVE THREAD MODEL INJECTION ===
    let domainHint = "DOMAIN: This thread appears to be MIXED / GENERAL.";
    const lowerTitle = title.toLowerCase();
    const lowerSummary = richContextBlock.toLowerCase();
    
    if (lowerSummary.includes("quantum") || lowerSummary.includes("galaxy") || lowerSummary.includes("crystal") ||
        lowerSummary.includes("consciousness") || lowerSummary.includes("neuroscience") || lowerSummary.includes("dna") ||
        lowerSummary.includes("ryugu") || lowerSummary.includes("nucleobase") || lowerSummary.includes("synaptic") ||
        lowerSummary.includes("llm") || lowerSummary.includes("ai") || lowerSummary.includes("technology")) {
      domainHint = "DOMAIN: This thread is primarily SCIENTIFIC/PHILOSOPHICAL.";
    } else if (lowerSummary.includes("art") || lowerSummary.includes("music") || lowerSummary.includes("poetry") ||
               lowerSummary.includes("baroque") || lowerSummary.includes("met gala") || lowerSummary.includes("cultural") ||
               lowerSummary.includes("media") || lowerSummary.includes("late-night") || lowerSummary.includes("dei")) {
      domainHint = "DOMAIN: This thread is primarily CULTURAL/ARTISTIC.";
    } else if (lowerSummary.includes("spacex") || lowerSummary.includes("compute") || lowerSummary.includes("data center") ||
               lowerSummary.includes("agent") || lowerSummary.includes("gemini") || lowerSummary.includes("claude")) {
      domainHint = "DOMAIN: This thread is primarily TECHNOLOGICAL.";
    } else if (lowerSummary.includes("trump") || lowerSummary.includes("democrat") || lowerSummary.includes("republican") ||
               lowerSummary.includes("election") || lowerSummary.includes("congress") || lowerSummary.includes("iran")) {
      domainHint = "DOMAIN: This thread is primarily POLITICAL.";
    }

    let modelContext = "";
    try {
      const modelData = JSON.parse(await fs.readFile('cumulative_thread_model.json', 'utf8'));
      modelContext = `\n\n${domainHint}\n\n--- CUMULATIVE THREAD MODEL (from ${modelData.totalThreadsProcessed} prior threads) ---\n${JSON.stringify(modelData, null, 2)}\nUse this historical context to ground your analysis, detect recurring patterns across ALL domains, and make forward-looking insights appropriate to the detected domain.`;
    } catch (e) {
      console.log("   ⚠️ No cumulative_thread_model.json yet — starting fresh.");
    }

    // === STRONGER HYPOTHESIS INSTRUCTION (forces generation on cultural/scientific/technological patterns) ===
    const hypothesisRule = `
## HYPOTHESIS
ALWAYS output a HYPOTHESIS section unless the thread is purely trivial. 
Look for ANY recurring, testable pattern about human nature, institutional behavior, cultural decay, technological displacement, media fragmentation, scientific implications, or philosophical tensions.

Output exactly:

## HYPOTHESIS

Followed by one concise paragraph (2–5 sentences) stating the claim, its current status (supported / partially supported / weakened / inconclusive), and evidence from this thread + the cumulative model. Be evidence-based and neutral. Highlight uncertainty.

If truly no pattern exists, output nothing — but this should be rare.`;

    userPrompt = userPrompt + modelContext + hypothesisRule;
    // =================================================

    const generated = await generateText(selPrompt.system, userPrompt);
    if (!generated) continue;

// === EXTRACT FORECAST + HYPOTHESIS (handles BOTH ## and ** markdown) ===
const forecastMatch = generated.match(/(?:##|\*\*)\s*FORECAST:?\s*([\s\S]*?)(?=(?:\n\n?(?:##|\*\*)\s*(?:HYPOTHESIS|IMAGE|I2V|T2V|VERSE|MUSIC))|$)/i);
const hypothesisMatch = generated.match(/(?:##|\*\*)\s*HYPOTHESIS:?\s*([\s\S]*?)(?=(?:\n\n?(?:##|\*\*)\s*(?:IMAGE|I2V|T2V|VERSE|MUSIC))|$)/i);

let modelUpdateContent = '';
if (forecastMatch && forecastMatch[1].trim()) {
  modelUpdateContent += '## FORECAST\n' + forecastMatch[1].trim() + '\n\n';
}
if (hypothesisMatch && hypothesisMatch[1].trim()) {
  modelUpdateContent += '## HYPOTHESIS\n' + hypothesisMatch[1].trim() + '\n\n';
}

// === DEDUPLICATE SECTIONS (prevents LLM echo/duplicates) ===
modelUpdateContent = modelUpdateContent
  .replace(/## FORECAST[\s\S]*?## FORECAST/i, '## FORECAST')
  .replace(/## HYPOTHESIS[\s\S]*?## HYPOTHESIS/i, '## HYPOTHESIS');

if (modelUpdateContent) {
  console.log(`   📡 Extracted FORECAST + HYPOTHESIS for model update (thread ${folder})`);
  await updatePoliticalModel(modelUpdateContent, folder, generated.substring(0, 500));
} else {
  console.warn("   ⚠️ No FORECAST or HYPOTHESIS section found — model update skipped for this thread.");
  console.log("   🔍 First 1500 chars of generated output:\n", generated.substring(0, 1500));
}

    const parsed = parseOutput(generated);
    const slug = slugify(title).substring(0, 40);

    // ==========================================
    // 1. IMAGE GENERATION
    // ==========================================
    let imgRes;
    if (useGrokImagine) {
      imgRes = await runGrokImagine(parsed.image, slug);
    } else if (useGeminiImage) {
      imgRes = await runGeminiImage(parsed.image, slug);
    } else {
      imgRes = await runImageGen(parsed.image);
    }
    
    if (!useGeminiImage) await freeComfyVRAM();
    await new Promise(r => setTimeout(r, 5000)); 

    // ==========================================
    // 2. VIDEO GENERATION
    // ==========================================
    let vidRes = { success: false, markdown: '' };
    if (useGeminiVideo) {
        vidRes = await runGeminiVideo(parsed.t2v, slug);
    } else {
    const isActuallyT2V = forceT2V || useHunyuan;
    const useSpicedI2V = useT2VPromptForI2V && !isActuallyT2V && imgRes.success;
    
    let videoPromptToUse = parsed.i2v;           // default
    let effectiveI2VMode = true;

    if (useSpicedI2V) {
        videoPromptToUse = parsed.t2v;           // ← spice it up!
        console.log(`\n🎬 Generating Spiced I2V (using T2V prompt on anchor image)...`);
    } else if (isActuallyT2V) {
        videoPromptToUse = parsed.t2v;
        effectiveI2VMode = false;
        console.log(`\n🎬 Generating Local Video (T2V mode)...`);
    } else {
        console.log(`\n🎬 Generating Local Video (I2V mode)...`);
    }

    if (!imgRes.success && !isActuallyT2V) {
        console.warn("\n⚠️ Local Image generation failed! Skipping I2V Video to prevent random hallucinations.");
    } else {
        vidRes = await runVideoGen(videoPromptToUse, imgRes.filename, !effectiveI2VMode);
    }
}
    
    if (!useGeminiVideo) await freeComfyVRAM();
    await new Promise(r => setTimeout(r, 5000));

    // ==========================================
    // 3. POETRY TTS (Always Local)
    // ==========================================
    const ttsRes = await runPoetryTTS(parsed.verse);
    await freeComfyVRAM(); 
    await new Promise(r => setTimeout(r, 5000));

    // ==========================================
    // 4. MUSIC GENERATION
    // ==========================================
    const finalDuration = (typeof generationDuration !== 'undefined' && generationDuration !== 90) ? generationDuration : (parseInt(parsed.musicDuration, 10) || 128); 
    
    let audioRes;
    if (useGeminiAudio) {
        audioRes = await runGeminiAudio(parsed.musicTags, parsed.musicLyrics, slug);
    } else if (useHeartmula) {
        console.log(`\n🎧 Generating audio track via Heartmula (Capped at 96s)...`);
        audioRes = await runAudioGen(parsed.musicTags, parsed.musicLyrics, slug, 96); 
    } else {
        console.log(`\n🎧 Generating audio track via ACE-Step (${finalDuration}s)...`);
        audioRes = await runAceStepGen(parsed.musicTags, parsed.musicLyrics, slug, finalDuration);
    }
    
    if (!useGeminiAudio) await freeComfyVRAM();

       // ==========================================
    // 5. MP4 STITCHING
    // ==========================================
    if (imgRes.success && audioRes.success) {
        const mp4Filename = `x_ready_music_${slug}_${Date.now()}.mp4`;
        const mp4Path = path.join(IMAGES_DIR, mp4Filename);
        
        console.log(`\n🎬 Stitching X.com Album Art Video...`);
        try {
            await execFileAsync('ffmpeg', [
                '-loop', '1', '-framerate', '1',
                '-i', path.join(IMAGES_DIR, imgRes.filename),
                '-i', path.join(IMAGES_DIR, audioRes.filename),
                '-c:v', 'libx264', '-tune', 'stillimage',
                '-c:a', 'aac', '-b:a', '192k',
                '-pix_fmt', 'yuv420p', '-shortest', '-y', mp4Path
            ]);
            console.log(`   ✅ Saved X-compatible video: ${mp4Filename}`);
        } catch (e) {
            console.error(`   ❌ Failed to stitch MP4: ${e.message}`);
        }
    }

    // === FINAL COMFYUI VRAM CLEANUP ===
    // This runs after ACE-Step (and all other Comfy-based stages) so the terminal
    // can be reused immediately for the next thread without memory fragmentation.
    await freeComfyVRAM();
    console.log("   🧹 Final ComfyUI VRAM cleanup completed for next run.");

    // ==========================================
    // 6. BUILD MARKDOWN POST (FINAL VERSION) — FORECAST/HYPOTHESIS BEFORE VIDEO
    // ==========================================

    const frontMatterLines = [];
    if (imgRes.success) frontMatterLines.push(`image: /images/${imgRes.filename}`);
    if (vidRes.success) frontMatterLines.push(`video: /images/${vidRes.filename}`);
    if (ttsRes.success) frontMatterLines.push(`tts: /images/${ttsRes.filename}`); 
    if (audioRes.success) frontMatterLines.push(`audio: true`);
    
    const author = useGrok ? "Grok" : "Gemini";

    // Clean extracted sections for clean display
    const displayForecast = modelUpdateContent.includes('## FORECAST') 
      ? modelUpdateContent.match(/## FORECAST\s*([\s\S]*?)(?=\n\n## HYPOTHESIS|$)/i)?.[1]?.trim() || ''
      : '';

    const displayHypothesis = modelUpdateContent.includes('## HYPOTHESIS') 
      ? modelUpdateContent.match(/## HYPOTHESIS\s*([\s\S]*?)(?=\n\n## IMAGE|$)/i)?.[1]?.trim() || ''
      : '';

    let markdown = `---
title: "${title} – Transmuted"
author: ${author} + Hybrid Pipeline
${frontMatterLines.length ? frontMatterLines.join('\n') : ''}
---

## Contents

- [Verse](#verse)
- [Forecast](#forecast)
- [Hypothesis](#hypothesis)
- [Generated Video](#generated-video)
- [Generated Visuals](#generated-visuals)
- [Generated Audio](#generated-audio)
- [Pipeline & Engine Details](#pipeline-details)

---

### Original Thread Group
<details><summary>Expand original curated thread</summary>
<pre>${richContextBlock.trim()}</pre>
</details>

<hr>

### Verse {#verse}
${parsed.verse || '_No verse generated_'}
${ttsRes.markdown || ''} 
<hr>

## FORECAST {#forecast}
${displayForecast || '_No forecast generated_'}

## HYPOTHESIS {#hypothesis}
${displayHypothesis || '_No hypothesis generated_'}

<hr>

<details><summary>Expand original curated thread</summary>
<pre>${richContextBlock.trim()}</pre>
</details>

<hr>

### Generated Video {#generated-video}
${vidRes.markdown || '_Video generation failed/skipped_'}

<details><summary>I2V Prompt (Local Image-to-Video)</summary>
<pre>${parsed.i2v || '_No I2V prompt generated_'}</pre>
</details>

<details><summary>T2V Prompt (Standalone Text-to-Video)</summary>
<pre>${parsed.t2v || '_No T2V prompt generated_'}</pre>
</details>

<hr>

### Generated Visuals (Anchor Image) {#generated-visuals}
${imgRes.markdown || '_Image generation failed_'}

<details><summary>Image Prompt</summary>
<pre>${parsed.image || '_No prompt_'}</pre>
</details>

<hr>

### Generated Audio (Music) {#generated-audio}
${audioRes.markdown || '_Background music generation failed or timed out_'}

<details><summary>Audio Prompt</summary>
<strong>Engine:</strong> ${audioRes.engine || 'Unknown'}<br>
<strong>Tags:</strong> ${parsed.musicTags}
<br><br>
<pre>${parsed.musicLyrics || '_No prompt_'}</pre>
</details>

<hr>

<details id="pipeline-details"><summary>Pipeline & Engine Details</summary>
<strong>Text Engine:</strong> ${actualModelUsed}<br>
<strong>Prompt Style:</strong> ${selPrompt.name}<br>
<strong>Image Engine:</strong> ${imgRes.engine || 'Skipped/Failed'}<br>
<strong>Video Engine:</strong> ${vidRes.engine || 'Skipped/Failed'}<br>
<strong>TTS Engine:</strong> ${ttsRes.engine || 'Skipped/Failed'}<br>
<strong>Music Engine:</strong> ${audioRes.engine || 'Skipped/Failed'}
<br><br>
<pre><code>System prompt:\n${selPrompt.system}\n\nChat prompt:\n\n${userPrompt}</code></pre>
</details>
`;

    // === APPEND LATEST CUMULATIVE MODEL INSIGHTS (unchanged) ===
    let modelInsights = '';
    try {
      const modelData = JSON.parse(await fs.readFile('cumulative_thread_model.json', 'utf8'));
      const patternsList = modelData.recurringPatterns && modelData.recurringPatterns.length > 0
        ? modelData.recurringPatterns.join(', ')
        : 'None detected yet';
      
      modelInsights = `\n\n<details><summary>📊 Latest Cumulative Thread Model Insights</summary>\n` +
        `<strong>Total Threads Processed:</strong> ${modelData.totalThreadsProcessed}<br>\n` +
        `<strong>Recurring Patterns (${modelData.recurringPatterns.length}):</strong> ${patternsList}<br><br>\n` +
        `<strong>Latest Model Summary:</strong><br>${modelData.summary}\n` +
        `</details>`;
    } catch (e) {
      console.warn(`   ⚠️ Could not load cumulative_thread_model.json for insights section: ${e.message}`);
      modelInsights = `\n\n<details><summary>📊 Latest Cumulative Thread Model Insights</summary>\n` +
        `<em>Model file not found or unreadable on this run.</em>\n` +
        `</details>`;
    }

    markdown += modelInsights;

    // === WRITE THE FINAL FILE ===
    const finalSlug = `${slug}-${folder}-${Date.now()}`;
    const outPath = path.join(POSTS_DIR, `${finalSlug}.md`);

    await fs.writeFile(outPath, markdown);
    console.log(`\n💾 Saved post: ${outPath}`);
  }

  console.log("\nAll done.");
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
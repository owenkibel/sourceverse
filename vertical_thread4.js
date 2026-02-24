const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const { execFile } = require('child_process');
const util = require('util');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const OpenAI = require("openai");

const execFileAsync = util.promisify(execFile);

// --- CONFIGURATION ---
const PROMPTS_DIR = path.join(__dirname, 'prompts');
const POSTS_DIR = 'posts';
const IMAGES_DIR = 'images';
const X_DIR = './x';

// HeartMuLa Directories
const HEART_INBOX = '/home/owen/ai-projects/heartmula/inbox';
const HEART_OUTBOX = '/home/owen/ai-projects/heartmula/outbox';

const MODEL_GROK = "grok-4-1-fast-non-reasoning";
const MAX_CHARS_GEMINI = 1900000;
const MAX_CHARS_GROK = 500000;

// --- FLAGS ---
const args = process.argv.slice(2);
const useGrok = args.includes('--grok');

// NEW: Duration Flag (e.g., --duration=60). Default to 90.
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
if (!useGrok && !process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");

// Clients
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const grokClient = useGrok ? new OpenAI({ apiKey: process.env.XAI_API_KEY, baseURL: "https://api.x.ai/v1" }) : null;

// --- UTILS ---
const slugify = (t) => (t || '').toString().toLowerCase()
  .replace(/\s+/g, '-')
  .replace(/[^\w\-]+/g, '')
  .replace(/^-+|-+$/g, '');

function cleanVerseText(text) {
  if (!text) return "";
  return text.replace(/\*\*|__|###/g, '')
             .replace(/<[^>]*>?/gm, '')
             .replace(/[ \t]+$/gm, '')
             .trim();
}

// Add this utility function to vertical_thread.js
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
    available.push({
      name: path.basename(file, '.json'),
      system: repl(p.system),
      chat: repl(p.chat)
    });
  }
  return available;
}

function parseOutput(text) {
  const sections = { verse: '', image: '', video: '', music: '' };
  let current = 'verse';
  text.split('\n').forEach(line => {
    const l = line.trim().toLowerCase();
    if (l.match(/^(#+|\*\*|__)?\s*image prompt/)) current = 'image';
    else if (l.match(/^(#+|\*\*|__)?\s*video prompt/)) current = 'video';
    else if (l.match(/^(#+|\*\*|__)?\s*music prompt/)) current = 'music';
    else if (l.match(/^(#+|\*\*|__)?\s*verse/)) current = 'verse';
    else if (sections[current] !== undefined) sections[current] += line + '\n';
  });

  // --- SANITIZATION LOGIC ---
  let rawMusic = sections.music.trim();
  
  // 1. Strip Markdown code blocks completely
  rawMusic = rawMusic.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '');

  let tags = "high fidelity, stereo";
  let duration = "90"; // Fallback
  
  // 2. Extract and sanitize TAGS
  const tagMatch = rawMusic.match(/TAGS:\s*(.*)/i);
  if (tagMatch) {
      let rawTags = tagMatch[1].replace(/[*_`#]/g, '').trim();
      tags = rawTags.split(',')
                    .map(t => t.trim())
                    .filter(t => t.length > 0)
                    .join(',');
      rawMusic = rawMusic.replace(tagMatch[0], ''); 
  }

  // 3. Extract and sanitize DURATION
  const durMatch = rawMusic.match(/DURATION:\s*(\d+)/i);
  if (durMatch) {
      duration = durMatch[1].trim();
      rawMusic = rawMusic.replace(durMatch[0], ''); 
  }

  // 4. Sanitize the Lyrics payload
  let lyrics = rawMusic
      .replace(/[*_#`]/g, '')           // Strip markdown bold/italic/headers/inline-code
      .replace(/LYRICS:/gi, '')         // Remove literal "LYRICS:" heading
      .replace(/\n{3,}/g, '\n\n')       // Collapse excessive blank lines
      .trim();

  return {
    verse: cleanVerseText(sections.verse),
    image: sections.image.trim(),
    video: sections.video.trim(),
    musicTags: tags,
    musicDuration: duration,
    musicLyrics: lyrics
  };
}

async function generateText(system, user) {
  const maxChars = useGrok ? MAX_CHARS_GROK : MAX_CHARS_GEMINI;
  const truncatedUser = user.length > maxChars ? user.substring(0, maxChars) + '\n\n[Input truncated for length]' : user;

  if (useGrok) {
    console.log(`Generating with Grok (${MODEL_GROK})`);
    const res = await grokClient.chat.completions.create({
      model: MODEL_GROK,
      messages: [
        { role: "system", content: system },
        { role: "user", content: truncatedUser }
      ],
      temperature: 1.0
    });
    return res.choices[0]?.message?.content || '';
  } else {
    console.log("Generating with Gemini");
    for (const modelName of ["gemini-2.5-flash", "gemini-2.5-flash-lite"]) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName, generationConfig: { temperature: 1 } });
        const res = await model.generateContent(`${system}\n\n${truncatedUser}`);
        return res.response.text();
      } catch (e) {
        console.warn(`${modelName} failed: ${e.message}`);
      }
    }
  }
  throw new Error("All text generation attempts failed");
}

async function runImageGen(prompt) {
  const stateFile = path.join(os.tmpdir(), `state-${Date.now()}.json`);
  try {
    await fs.writeFile('prompt.txt', prompt || 'Abstract surreal composition', 'utf8');
    const { stderr } = await execFileAsync('bun', ['run_z_turbo.js', '--state-file', stateFile]);
    if (stderr && stderr.includes("Error:")) console.warn(`[Z-Turbo] ${stderr}`);

    if (! (await fs.stat(stateFile).catch(() => false))) throw new Error("No state file – script failed");
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    const filename = state.filename;

    return { success: true, filename, markdown: `\n<img src="/images/${filename}" />\n` };
  } catch (e) {
    console.error(`Image generation failed: ${e.message}`);
    return { success: false, markdown: '' };
  } finally {
    await fs.unlink(stateFile).catch(() => {});
    await fs.unlink('prompt.txt').catch(() => {});
  }
}

// Add duration parameter to the function
async function runAudioGen(tags, lyrics, slug, duration) {
    const baseName = `hm_${slug}_${Date.now()}`;
    const txtFile = path.join(HEART_INBOX, `${baseName}.txt`);
    const wavFile = path.join(HEART_OUTBOX, `${baseName}.wav`);
    const opusFile = path.join(IMAGES_DIR, `${baseName}.opus`); 
    
    try {
        await fs.mkdir(HEART_INBOX, { recursive: true });
        await fs.mkdir(HEART_OUTBOX, { recursive: true });

        // 1. Dispatch to Watchdog with the new DURATION header
        const finalOutput = `TAGS: ${tags}\nDURATION: ${duration}\n\n${lyrics}`;
        await fs.writeFile(txtFile, finalOutput);
        console.log(`🎼 Audio Request sent (${duration}s): ${baseName}.txt`);

        // 2. Poll for Watchdog output
        let attempts = 0;
        const pollIntervalMs = 5000; 
        const maxAttempts = 240; 
        let found = false;

        process.stdout.write(`   ⏳ Waiting for HeartMuLa (${duration}s track) `);
        while (attempts < maxAttempts) {
            try {
                const stats = await fs.stat(wavFile);
                if (stats.size > 1000) {
                    found = true;
                    await new Promise(r => setTimeout(r, 1000));
                    console.log(`\n   ✅ Found generated audio: ${baseName}.wav`);
                    break;
                }
            } catch (err) {}
            process.stdout.write(".");
            await new Promise(r => setTimeout(r, pollIntervalMs));
            attempts++;
        }

        if (!found) return { success: false, markdown: '' };

        // 3. Compress to Opus AND apply a 5-second fade out
        console.log(`   🎵 Applying fade-out and converting to Opus...`);
        const fadeStart = Math.max(0, duration - 5); // Start fading 5 seconds before the end
        
        await execFileAsync('ffmpeg', [
            '-y', 
            '-i', wavFile, 
            '-af', `afade=t=out:st=${fadeStart}:d=5`, // The magic fade-out filter
            '-c:a', 'libopus', 
            '-b:a', '128k', 
            opusFile
        ]);

        await fs.unlink(wavFile).catch(() => {});
        
        return { 
            success: true, 
            markdown: `\n<audio controls src="/images/${baseName}.opus"></audio>\n` 
        };

    } catch (e) {
        console.error(`\n   ❌ Audio Generation Error: ${e.message}`);
        return { success: false, markdown: '' };
    }
}

async function main() {
  await Promise.all([fs.mkdir(POSTS_DIR, { recursive: true }), fs.mkdir(IMAGES_DIR, { recursive: true })]);

  const prompts = await loadPrompts();
  if (prompts.length === 0) throw new Error("No valid prompts found");

  const selPrompt = prompts[Math.floor(Math.random() * prompts.length)];
  console.log(`Selected prompt style: ${selPrompt.name}`);

  const allFolders = await fs.readdir(X_DIR);
  const threadFolders = allFolders.filter(f => /^t\d+$/.test(f)).sort();

  const toProcess = targetThread
    ? threadFolders.filter(f => f === targetThread)
    : threadFolders;

  if (toProcess.length === 0) {
    console.log(`No matching thread folder found in ${X_DIR}`);
    return;
  }

  for (const folder of toProcess) {
    console.log(`\n--- Processing ${folder} ---`);
    const folderPath = path.join(X_DIR, folder);
    const threadPath = path.join(folderPath, 'x-thread.txt');

    let threadText;
    try {
      threadText = await fs.readFile(threadPath, 'utf8');
    } catch (e) {
      console.warn(`Could not read x-thread.txt in ${folder}`);
      continue;
    }

    let title = folder.toUpperCase();
    const firstLine = threadText.split('\n')[0]?.trim();
    if (firstLine?.startsWith('## ')) {
      title = firstLine.substring(3).trim();
    }

    const userPrompt = `${
      selPrompt.chat.includes('[[chunk]]')
        ? selPrompt.chat.replace('[[chunk]]', threadText)
        : selPrompt.chat + '\n\nAnalyze and transmute:\n' + threadText
    }`;

    const generated = await generateText(selPrompt.system, userPrompt);
    if (!generated) {
      console.warn(`Generation failed for ${folder}`);
      continue;
    }

    const parsed = parseOutput(generated);
    const slug = slugify(title).substring(0, 40);

// Run Image Generation
    console.log("\n🎨 Generating image from prompt...");
    const imgRes = await runImageGen(parsed.image);
    
    // --> NEW: Clear VRAM before audio generation
    await freeComfyVRAM();
    // Give the GPU half a second to actually flush the memory
    await new Promise(r => setTimeout(r, 500)); 

    // Use the command-line flag duration if provided, otherwise default to the parsed prompt duration
    // Assumes you added the `let generationDuration = ...` flag logic at the top of the file
    const finalDuration = (typeof generationDuration !== 'undefined' && generationDuration !== 90) 
        ? generationDuration 
        : (parseInt(parsed.musicDuration, 10) || 90);

    // Run Audio Generation Sequentially to respect GPU limits
    console.log(`\n🎧 Generating audio track (${finalDuration}s)...`);
    const audioRes = await runAudioGen(parsed.musicTags, parsed.musicLyrics, slug, finalDuration);

    if (imgRes.success) {
      // Small buffer to allow ComfyUI/GPU VRAM to settle
      await new Promise(r => setTimeout(r, 5000));
    }

    const frontMatterLines = [];
    if (imgRes.success) frontMatterLines.push(`image: /images/${imgRes.filename}`);
    if (audioRes.success) frontMatterLines.push(`audio: true`);
    const frontMatter = frontMatterLines.length ? frontMatterLines.join('\n') : '';

    const author = useGrok ? "Grok" : "Gemini";

    const markdown = `---
title: "${title} – Transmuted"
author: ${author} + ComfyUI/HeartMuLa
${frontMatter}
---

### Original Thread Group
<details><summary>Expand original curated thread</summary>
<pre>${threadText.trim()}</pre>
</details>

<hr>

### Verse
${parsed.verse || '_No verse generated_'}

<hr>

### Generated Visuals
${imgRes.markdown || '_Image generation failed_'}

<details><summary>Image Prompt</summary>
<pre>${parsed.image || '_No prompt_'}</pre>
</details>

<hr>

### Generated Audio
${audioRes.markdown || '_Audio generation failed or timed out_'}

<details><summary>Audio Prompt</summary>
<strong>Tags:</strong> ${parsed.musicTags}
<pre>${parsed.musicLyrics || '_No prompt_'}</pre>
</details>

<hr>

### Video Prompts
${parsed.video || '_No video prompts generated_'}

<hr>

<details><summary>Prompt & Model Details</summary>
<strong>Text Model:</strong> ${useGrok ? MODEL_GROK : 'Gemini 2.5 Flash'}\n
<strong>Prompt Style:</strong> ${selPrompt.name}\n
<pre><code>System prompt:\n${selPrompt.system}</code></pre>
</details>
`;

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
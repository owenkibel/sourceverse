const path = require('path');
const fs = require('fs/promises');
const { existsSync } = require('fs');
const os = require('os');
const { execFile, exec } = require('child_process');
const util = require('util');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const yaml = require('js-yaml');
const OpenAI = require("openai");

const execFileAsync = util.promisify(execFile);
const execAsync = util.promisify(exec);

// --- CONFIGURATION ---
const DIRS = {
    INPUT_DATA: 'ogs_data',
    JSON_COPY: 'json',
    PROMPTS: path.join(__dirname, 'prompts'),
    POSTS: 'posts',
    IMAGES: 'images',
    JAMIFY: '/home/owen/cachyos2/owen/sourceverse/jamify',
    COOKIES: path.join(__dirname, 'cookies.txt')
};

const CFG = {
    SNIPPET_START: 30,
    SNIPPET_DURATION: 60,
    JAMIFY_VAE: "stable_audio",
    MODELS_TEXT: ["gemini-2.5-flash", "gemini-2.5-flash-lite"],
    MODELS_VISION: ["gemini-2.5-flash", "gemini-2.5-flash-lite"],
    MODEL_GROK: "grok-4-1-fast-non-reasoning",
    MAX_CHARS: 1900000,
    GROK_MAX_CHARS: 500000,
    LYRICS_MAX_LINES: 8
};

// --- FLAGS ---
// --grok: Uses X.ai Grok model. Default: Gemini.
// --current: Uses existing audio snippet (if available).
// --create-snippet: Force re-creation of audio snippet from YouTube.
const FLAGS = {
    useCurrentAudio: process.argv.includes('--current'),
    createSnippet: process.argv.includes('--create-snippet'),
    useGrok: process.argv.includes('--grok'),
    useGrokSearch: process.argv.includes('--grok-search')
};

if (!process.env.API_KEY) throw new Error("API_KEY missing");
if (FLAGS.useGrok && !process.env.XAI_API_KEY) throw new Error("XAI_API_KEY missing");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const grokClient = FLAGS.useGrok ? new OpenAI({ apiKey: process.env.XAI_API_KEY, baseURL: "https://api.x.ai/v1" }) : null;

// --- UTILS ---
const slugify = (t) => (t || '').toString().toLowerCase().replace(/\s+/g, '-').replace(/[^\w\-]+/g, '').replace(/^-+|-+$/g, '');
const removeBoilerplate = (t) => (t || '').replace(/your browser.*?|sorry, youtube.*?|check for updates.*?|sign in|privacy policy|terms/gi, '').replace(/\s{2,}/g, ' ').trim();
const escapeHtml = (s) => (s || '').replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unescapeHtml = (s) => (s || '').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");

function cleanVerseText(text) {
    if (!text) return "";
    return text.replace(/\*\*|__|###/g, '').replace(/<[^>]*>?/gm, '').replace(/[ \t]+$/gm, '').trim();
}

// Ensure lyrics are plain text only (avoids "Unknown language" errors in DiffRhythm)
function cleanLyricsForModel(text, maxLines) {
    if (!text) return "";
    let clean = text.replace(/[^\w\s.,'"]/g, ''); // Strip weird symbols
    const lines = clean.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length > maxLines) return lines.slice(0, maxLines).join('\n');
    return lines.join('\n');
}

async function loadPrompts() {
    const files = await fs.readdir(DIRS.PROMPTS);
    const available = [];
    for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const p = JSON.parse(await fs.readFile(path.join(DIRS.PROMPTS, file), 'utf8'));
        if (!p.system || !p.chat) continue;
        const style = p.style?.[Math.floor(Math.random() * p.style.length)] || "";
        const poet = p.poet?.[Math.floor(Math.random() * p.poet.length)] || "";
        const repl = (s) => s.replace(/\[\[style]]/g, style).replace(/\[\[poet]]/g, poet);
        available.push({ name: path.basename(file, '.json'), system: repl(p.system), chat: repl(p.chat).includes('[[chunk]]') ? repl(p.chat) : repl(p.chat) + "\n\nAnalyze:\n[[chunk]]" });
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
        else if (l.match(/^(#+|\*\*|__)?\s*(music|audio) prompt/)) current = 'music';
        else if (l.match(/^(#+|\*\*|__)?\s*verse/)) current = 'verse';
        else if (sections[current] !== undefined) sections[current] += line + '\n';
    });
    const musicTags = sections.music.match(/tags:([\s\S]*?)(negative|$)/i)?.[1]?.trim().replace(/\n/g, ' ') || "baroque, orchestral, cello, cinematic, stereo";
    return { verse: cleanVerseText(sections.verse), image: sections.image.trim(), video: sections.video.trim(), music_tags: musicTags };
}

async function generateText(system, user) {
    if (FLAGS.useGrok) {
        console.log(`Using Grok: ${CFG.MODEL_GROK}`);
        try {
            const res = await grokClient.chat.completions.create({
                model: CFG.MODEL_GROK,
                messages: [{ role: "system", content: system }, { role: "user", content: user }],
                temperature: 1.0,
                search_parameters: FLAGS.useGrokSearch ? { mode: "on", max_search_results: 5 } : undefined
            });
            return res.choices[0]?.message?.content || '';
        } catch (e) { console.error("Grok error:", e.message); return ""; }
    } else {
        console.log("Using Gemini Fallback");
        for (const modelName of CFG.MODELS_TEXT) {
            try {
                const model = genAI.getGenerativeModel({ model: modelName, generationConfig: { temperature: 1 } });
                const res = await model.generateContent({ contents: [{ role: "user", parts: [{ text: `${system}\n\n${user}` }] }] });
                return res.response.text();
            } catch (e) { console.warn(`${modelName} failed:`, e.message); }
        }
    }
    throw new Error("Text generation failed.");
}

async function runComfyScript(scriptName, inputs) {
    const stateFile = path.join(os.tmpdir(), `state-${Date.now()}.json`);
    try {
        for (const [k, v] of Object.entries(inputs)) await fs.writeFile(k, v || '', 'utf8');
        const { stderr } = await execFileAsync('bun', [path.join(__dirname, scriptName), '--state-file', stateFile]);
        if (stderr && stderr.includes("Error:")) console.warn(`[${scriptName} log]`, stderr);
        
        if (!existsSync(stateFile)) throw new Error("No output state file. Script likely failed.");
        const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
        const tag = state.filename.endsWith('.opus') ? 'audio' : 'image';
        return { success: true, filename: state.filename, markdown: `\n<${tag} controls src="/images/${state.filename}"></${tag}>\n`, raw: state };
    } catch (e) {
        console.error(`[ERROR] ${scriptName} failed: ${e.message}`);
        // CRITICAL: Return success:false so the main script continues!
        return { success: false, error: e.message, markdown: `` };
    } finally { try { await fs.unlink(stateFile); } catch {} }
}

async function runJamify(tags, lyrics, duration) {
    if (!tags || !lyrics) return { success: false, markdown: "" };
    const id = `jamify-${Date.now()}`;
    const cfgPath = path.join(os.tmpdir(), `${id}.yaml`);
    const inputSong = 'current.mp3'; 
    try {
        await fs.mkdir(path.join(DIRS.JAMIFY, 'inputs'), { recursive: true });
        await fs.writeFile(path.join(DIRS.JAMIFY, 'inputs', 'prompt.txt'), tags);
        await fs.writeFile(path.join(DIRS.JAMIFY, 'inputs', 'timed_lyrics.json'), JSON.stringify(lyrics, null, 2));
        const inputJson = [{ id, audio_path: `inputs/${inputSong}`, lrc_path: "inputs/timed_lyrics.json", duration, prompt_path: "inputs/prompt.txt" }];
        await fs.writeFile(path.join(DIRS.JAMIFY, 'inputs', 'input.json'), JSON.stringify(inputJson, null, 2));
        const yamlCfg = yaml.load(await fs.readFile(path.join(DIRS.JAMIFY, 'configs', 'jam_infer.yaml'), 'utf8'));
        Object.assign(yamlCfg.evaluation, { vae_type: CFG.JAMIFY_VAE, num_style_secs: CFG.SNIPPET_DURATION, use_prompt_style: false });
        await fs.writeFile(cfgPath, yaml.dump(yamlCfg));
        const cmd = `bash -c 'source "${path.join(DIRS.JAMIFY, 'venv_py313/bin/activate')}" && export PYTHONPATH="${DIRS.JAMIFY}/src:$PYTHONPATH" && cd ${DIRS.JAMIFY} && python -c "import torch; torch.cuda.empty_cache()" && accelerate launch --mixed_precision=fp16 inference.py --config_path "${cfgPath}"'`;
        await execAsync(cmd, { cwd: __dirname });
        const genDir = path.join(DIRS.JAMIFY, 'outputs', 'generated');
        const rawFile = (await fs.readdir(genDir)).find(f => f.startsWith(id));
        if (!rawFile) throw new Error("No output found");
        const outName = `${id}.opus`;
        await new Promise((res, rej) => ffmpeg(path.join(genDir, rawFile)).audioCodec('libopus').audioBitrate('128k').save(path.join(DIRS.IMAGES, outName)).on('end', res).on('error', rej));
        return { success: true, markdown: `\n<audio controls src="/images/${outName}"></audio>\n`, prompts: { tags, lyrics, duration } };
    } catch (e) { return { success: false, markdown: `` }; }
    finally { try { await fs.unlink(cfgPath); } catch {} }
}

async function analyzeAudio(url) {
    if (!url) return { md: '', tags: '' };
    console.log(`Analyzing Audio: ${url}`);
    const temp = path.join(os.tmpdir(), `temp-${Date.now()}.opus`);
    const jamifyInput = path.join(DIRS.JAMIFY, 'inputs', 'current.mp3');
    try {
        const args = ['--no-playlist', '-f', 'bestaudio/best', '-x', '--audio-format', 'opus', '-o', temp, url];
        if (existsSync(DIRS.COOKIES)) args.unshift('--cookies', DIRS.COOKIES);
        await execFileAsync('yt-dlp', args);
        // Save Reference Audio
        await new Promise((res, rej) => ffmpeg(temp).setStartTime(CFG.SNIPPET_START).setDuration(CFG.SNIPPET_DURATION).toFormat('mp3').save(jamifyInput).on('end', res).on('error', rej));
        console.log(`Reference Audio Saved to: ${jamifyInput}`);
        
        const data = await fs.readFile(temp);
        const model = genAI.getGenerativeModel({ model: CFG.MODELS_TEXT[0] });
        const res = await model.generateContent(["Analyze this audio. Transcript & Soundscape. End with 'Music Tags: tag1, tag2'.", { inlineData: { data: data.toString("base64"), mimeType: "audio/opus" } }]);
        const txt = res.response.text();
        return { md: `<details><summary>Audio Analysis</summary><pre>${escapeHtml(txt)}</pre></details>`, tags: txt.match(/Music Tags:?([\s\S]*?)$/i)?.[1]?.trim() || '' };
    } catch (e) { 
        if(existsSync(temp) && !existsSync(jamifyInput)) {
             try { await new Promise((res, rej) => ffmpeg(temp).setStartTime(CFG.SNIPPET_START).setDuration(CFG.SNIPPET_DURATION).toFormat('mp3').save(jamifyInput).on('end', res).on('error', rej)); } catch{}
        }
        return { md: '', tags: '' }; 
    }
    finally { try { await fs.unlink(temp); } catch {} }
}

async function processOriginalImage(url, baseName) {
    if (!url) return "";
    let fname = "";
    let imageUrl = url;
    if (Array.isArray(url)) imageUrl = url[0];
    if (typeof imageUrl === 'object' && imageUrl?.url) imageUrl = imageUrl.url;
    if (typeof imageUrl !== 'string' || !imageUrl.startsWith('http')) return "";

    try {
        const directUrl = imageUrl.includes('?url=') ? decodeURIComponent(imageUrl.split('?url=')[1]) : imageUrl;
        const res = await axios.get(directUrl, { responseType: 'arraybuffer', headers: { 'User-Agent': 'Mozilla/5.0' } });
        const ext = path.extname(new URL(directUrl).pathname) || '.jpg';
        fname = `${baseName}-og-${Date.now()}${ext}`;
        await fs.writeFile(path.join(DIRS.IMAGES, fname), res.data);
    } catch (e) { return ``; }

    try {
        const model = genAI.getGenerativeModel({ model: CFG.MODELS_VISION[0] });
        const imagePath = path.join(DIRS.IMAGES, fname);
        const imageData = await fs.readFile(imagePath);
        const aiRes = await model.generateContent(["Describe this image specifically for a surreal image generation prompt.", { inlineData: { data: imageData.toString("base64"), mimeType: "image/jpeg" } }]);
        return `#### Vision Analysis
        
        ![](/images/${fname})\n\n${aiRes.response.text()}
        
        `;
    } catch (e) { return `#### Vision Analysis\n![](/images/${fname})\n\n\n`; }
}

async function processEntry(entry, promptData) {
    const { title, content, ogImage, ogAudio, baseFilename, sourceList } = entry;
    
    // 1. Analyze
    const visionOutput = await processOriginalImage(ogImage, baseFilename);
    const audioData = await analyzeAudio(ogAudio);

    // 2. Text Gen
    const max = FLAGS.useGrok ? CFG.GROK_MAX_CHARS : CFG.MAX_CHARS;
    const cleanContent = entry.content.substring(0, max);
    const userPrompt = `${promptData.chat.replace('[[chunk]]', cleanContent)}\n\n*** FORMAT: ### Verse, ### Image Prompt, ### Video Prompt, ### Music & Audio Prompts ***`;
    
    const genText = await generateText(promptData.system, userPrompt);
    if (!genText) return;

    const parsed = parseOutput(genText);

    console.log("--- Generating Media ---");
    
    const fullCleanLyrics = unescapeHtml(parsed.verse).replace(/<[^>]+>/g, '').trim();
    // Use Strict Cleaning to prevent "Unknown language" errors
    const cleanedLyrics = cleanLyricsForModel(fullCleanLyrics, CFG.LYRICS_MAX_LINES);
    
    let t = 15.5;
    const timedLyrics = cleanedLyrics.split('\n').flatMap(line => {
        const words = line.trim().split(/\s+/).map(w => {
            const word = w.replace(/[^\w'-]/g, '');
            if(!word) return null;
            const item = { start: t, end: t + 0.5, word };
            t += 0.5; return item;
        }).filter(Boolean);
        t += 0.25; return words;
    });

    const musicTags = parsed.music_tags || audioData.tags || "Baroque, Orchestral, Harpsichord, Stereo, Counterpoint";
    const refAudioPath = path.resolve(DIRS.JAMIFY, 'inputs', 'current.mp3');
    const hasRef = existsSync(refAudioPath);

    // --- GENERATION (Sequential & Robust) ---
    
    // Image: Z-Turbo
    const imgRes = await runComfyScript('run_z_turbo.js', { 'prompt.txt': parsed.image || "Abstract essence" });
    
    // Audio: DiffRhythm 2 (Baseline)
    console.log("--- Starting DiffRhythm 2 (Baseline) ---");
    const dr2BaseRes = await runComfyScript('run_diffrhythm2.js', { 'lyrics.txt': cleanedLyrics, 'style.txt': musicTags });

    // Audio: DiffRhythm 2 (Reference)
    let dr2RefRes = { success: false, markdown: '' };
    if (hasRef) {
        console.log("--- Starting DiffRhythm 2 (Reference) ---");
        dr2RefRes = await runComfyScript('run_diffrhythm2.js', { 'lyrics.txt': cleanedLyrics, 'style.txt': musicTags, 'ref_audio_path': refAudioPath });
    }

    if (imgRes.success || dr2BaseRes.success || dr2RefRes.success) {
        console.log("Waiting 30s for ComfyUI...");
        await new Promise(r => setTimeout(r, 30000));
    }

    // External: Jamify
    const jamRes = await runJamify(musicTags, timedLyrics.length ? timedLyrics : null, t + 15);

    // --- OUTPUT ---
    const frontMatter = [
        imgRes.success ? `image: /images/${imgRes.filename}` : '',
        dr2BaseRes.success ? `audio_dr2: /images/${dr2BaseRes.filename}` : '',
        dr2RefRes.success ? `audio_dr2_ref: /images/${dr2RefRes.filename}` : ''
    ].filter(Boolean).join('\n');

    const sources = sourceList ? `**Sources:**\n${sourceList.map(s => `- [${s.title}](${s.url||'#'})`).join('\n')}` : `Source: [${title}](${entry.url||'#'})`;

    const md = `---
title: "${escapeHtml(title)}"
author: ${FLAGS.useGrok ? "Grok" : "Gemini"} + ComfyUI
${frontMatter}
---
${sources}
<hr>
### Verse
${parsed.verse}
<hr>

### Generated Media
**Image (Z-Turbo):** ${imgRes.markdown}
<details><summary>Prompt</summary>${escapeHtml(parsed.image)}</details>

**Music (DiffRhythm 2 - Baseline):** ${dr2BaseRes.markdown}
<details><summary>Details</summary>
<strong>Tags:</strong><pre>${escapeHtml(musicTags)}</pre>
<strong>Lyrics Used:</strong><pre>${escapeHtml(cleanedLyrics)}</pre>
</details>

**Music (DiffRhythm 2 - Reference):** ${dr2RefRes.markdown}
<details><summary>Details</summary>
<p>Uses reference audio.</p>
<strong>Tags:</strong><pre>${escapeHtml(musicTags)}</pre>
</details>

**Music (Jamify):** ${jamRes.markdown}
<details><summary>Details</summary>
<strong>Prompt:</strong><pre>${escapeHtml(jamRes.prompts?.tags)}</pre>
<strong>Duration:</strong><pre>${jamRes.prompts?.duration}s</pre>
</details>

<hr>
### Analysis
${visionOutput}
${audioData.md}

<details><summary>Models & Prompt</summary>
<p><strong>Text:</strong> ${FLAGS.useGrok ? CFG.MODEL_GROK : CFG.MODELS_TEXT.join(' -> ')}</p>
<p><strong>Prompt Name:</strong> ${promptData.name}</p>
<p><strong>System Prompt:</strong></p>
<pre><code>${escapeHtml(promptData.system)}</code></pre>
<p><strong>Chat Prompt:</strong></p>
<pre><code>${escapeHtml(promptData.chat)}</code></pre>
</details>
`;
    
    const outFile = path.join(DIRS.POSTS, `${slugify(title).substring(0,50)}-${Date.now()}.md`);
    await fs.writeFile(outFile, md);
    console.log(`Saved: ${outFile}`);
}

async function main() {
    await Promise.all(Object.values(DIRS).map(d => !path.extname(d) && fs.mkdir(d, { recursive: true })));
    const prompts = await loadPrompts();
    const selPrompt = prompts[Math.floor(Math.random() * prompts.length)];
    console.log(`Prompt: ${selPrompt.name}`);
    const files = (await fs.readdir(DIRS.INPUT_DATA)).filter(f => f.endsWith('.json'));
    if (files.length === 0) { console.log("No files in ogs_data."); return; }
    let entry = {};
    if (files.length > 1) {
        console.log(`>>> GROUP MODE DETECTED (${files.length} files) <<<`);
        let combined = "", titles = [], sources = [], firstImg = null, firstAudio = null, audioCount = 0;
        for (const f of files) {
            const data = JSON.parse(await fs.readFile(path.join(DIRS.INPUT_DATA, f), 'utf8'));
            const og = data.ogResult || {};
            const t = og.ogTitle || data.title || f;
            titles.push(t);
            sources.push({ title: t, url: og.ogUrl });
            let currentImg = og.ogImage;
            if (Array.isArray(currentImg)) currentImg = currentImg[0]?.url || currentImg[0];
            if (typeof currentImg === 'object' && currentImg?.url) currentImg = currentImg.url;
            if (!firstImg && typeof currentImg === 'string') firstImg = currentImg;
            if (og.ogUrl?.includes('youtu')) { audioCount++; if (!firstAudio) firstAudio = og.ogUrl; }
            combined += `\n--- SOURCE: ${t} ---\n${removeBoilerplate((og.ogDescription||'') + " " + (data.ogHTML||''))}\n`;
            await fs.writeFile(path.join(DIRS.JSON_COPY, f), JSON.stringify(data, null, 2));
        }
        if (audioCount > 1) { console.log(`Skipping Audio Analysis: ${audioCount} audio sources detected.`); firstAudio = null; }
        entry = { title: `Group: ${titles.slice(0, 3).join(', ')}...`, content: combined, ogImage: firstImg, ogAudio: firstAudio, baseFilename: 'group', sourceList: sources };
    } else {
        console.log(">>> SINGLE MODE <<<");
        const f = files[0];
        const data = JSON.parse(await fs.readFile(path.join(DIRS.INPUT_DATA, f), 'utf8'));
        const og = data.ogResult || {};
        await fs.writeFile(path.join(DIRS.JSON_COPY, f), JSON.stringify(data, null, 2));
        let img = og.ogImage;
        if (Array.isArray(img)) img = img[0]?.url || img[0];
        if (typeof img === 'object' && img?.url) img = img.url;
        entry = { title: og.ogTitle || f, url: og.ogUrl, content: removeBoilerplate([og.ogTitle, og.ogDescription, data.ogHTML].join('\n')), ogImage: img, ogAudio: og.ogUrl?.includes('youtu') ? og.ogUrl : null, baseFilename: path.basename(f, '.json') };
    }
    await processEntry(entry, selPrompt);
}

main().catch(console.error);
const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');
const os = require('os');
const util = require('util');
const { execFile } = require('child_process');
const execFileAsync = util.promisify(execFile);
const { exec } = require('child_process');
const execAsync = util.promisify(exec);
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const yaml = require('js-yaml');
const OpenAI = require("openai");

// --- SCRIPT CONFIGURATION ---

const INPUT_GROUP_DIR = 'ogs_group';
const INPUT_DATA_DIR = 'ogs_data';
const JSON_COPY_DIR = 'json';
const PROMPTS_DIR = path.join(__dirname, 'prompts');
const OUTPUT_POSTS_DIR = 'posts';
const OUTPUT_IMAGES_DIR = 'images';

// Audio Settings
const SNIPPET_START_TIME_SECONDS = 30;
const SNIPPET_DURATION_SECONDS = 60;
const WORD_DURATION_SECONDS = 0.5;
const JAMIFY_VAE_TYPE = "stable_audio";
const JAMIFY_USE_PROMPT_STYLE = false;

// Jamify Paths
const JAMIFY_PROJECT_PATH = '/home/owen/cachyos2/owen/sourceverse/jamify';
const INPUT_AUDIO_DIR_JAMIFY = path.join(JAMIFY_PROJECT_PATH, 'inputs');
const JAMIFY_CURRENT_INPUT_SONG = 'current.mp3';
const JAMIFY_DEFAULT_INPUT_SONG = 'current.mp3';
const YT_DLP_COOKIES_PATH = path.join(__dirname, 'cookies.txt');

// Models
const TEXT_MODEL_NAMES = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
const VISION_MODEL_NAMES = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
const GROK_MODEL_NAME = "grok-4-fast-non-reasoning"; 
const MAX_CHUNK_SIZE_CHARS = 1900000;
const GROK_MAX_CHUNK_SIZE_CHARS = 500000;
const ACE_STEP_NEGATIVE_TAGS = "Mono, Harsh, Soft, Flat, Noisy, Indistinct, Muddy, Phasing, Flanging, Muffled, Dry, Ugly";

// Flags
const useCurrentAudio = process.argv.includes('--current');
const createSnippet = process.argv.includes('--create-snippet');
const useGrok = process.argv.includes('--grok');
const useGrokSearch = process.argv.includes('--grok-search');
const useGroupMode = process.argv.includes('--group');

// API Keys
const apiKey = process.env.API_KEY;
if (!apiKey) { console.error("FATAL: API_KEY environment variable for Google AI is not set."); process.exit(1); }
const grokApiKey = process.env.XAI_API_KEY;
if (useGrok && !grokApiKey) { console.error("FATAL: --grok flag is set, but GROK_API_KEY environment variable is not set."); process.exit(1); }

const genAI = new GoogleGenerativeAI(apiKey);
let grokClient;
if (useGrok) {
    grokClient = new OpenAI({ apiKey: grokApiKey, baseURL: "https://api.x.ai/v1", timeout: 360000 });
}

// --- FORMAT ENFORCEMENT ---
const FORMAT_REMINDER = `
\n\n*** CRITICAL OUTPUT FORMATTING INSTRUCTIONS ***
Regardless of the content analysis, you MUST structure your response using EXACTLY these section headers. Do not combine them.
1. ### Verse
2. ### Image Prompt
3. ### Video Prompt
4. ### Music & Audio Prompts
If you fail to include these headers, the magical generation process will fail.
**IMPORTANT FOR VERSE:** Output the verse as PLAIN TEXT. Do not use bolding (**), italics (*), or markdown headers (###) inside the verse section. Just text and newlines.
`;

// --- UTILS ---
function slugify(text) {
  if (!text) return '';
  return text.toString().toLowerCase()
    .replace(/\s+/g, '-')           // Replace spaces with -
    .replace(/[^\w\-]+/g, '')       // Remove all non-word chars
    .replace(/\-\-+/g, '-')         // Replace multiple - with single -
    .replace(/^-+/, '')             // Trim - from start of text
    .replace(/-+$/, '');            // Trim - from end of text
}
function removeBoilerplate(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/your browser is deprecated.*?upgrade|sorry, youtube music.*?|check for updates.*?|get chrome|sign in|privacy policy|terms of service/gi, '')
               .replace(/\s{2,}/g, ' ').replace(/^\s*[\r\n]/gm, '').trim();
}
function escapeHtml(unsafe) { if (typeof unsafe !== 'string') return unsafe == null ? '' : String(unsafe); return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
function unescapeHtml(text) { if (typeof text !== 'string') return text == null ? '' : String(text); return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&nbsp;/g, ' '); }

function cleanVerseText(text) {
    if (!text) return "";
    return text
        .replace(/\*\*/g, '') // Remove bold markdown
        .replace(/__/g, '')   // Remove bold markdown
        .replace(/###/g, '')  // Remove header markdown
        .replace(/<[^>]*>?/gm, '') // Strip any existing HTML tags
        .trim();
}

async function loadPromptFile(filePath) { 
    try { return JSON.parse(await fs.readFile(filePath, 'utf8')); } 
    catch (error) { throw new Error(`Failed to load/parse prompt file: ${filePath}.`); } 
}

async function loadAndPreparePrompts() {
    let availablePrompts = [];
    const promptFiles = await fs.readdir(PROMPTS_DIR);
    for (const file of promptFiles) {
        if (path.extname(file).toLowerCase() !== '.json') continue;
        const data = await loadPromptFile(path.join(PROMPTS_DIR, file));
        if (!data.system || !data.chat) continue;
        
        const style = data.style?.[Math.floor(Math.random() * data.style.length)] || "";
        const poet = data.poet?.[Math.floor(Math.random() * data.poet.length)] || "";
        
        let system = data.system.replace(/\[\[style]]/g, style).replace(/\[\[poet]]/g, poet);
        let chat = data.chat.replace(/\[\[style]]/g, style).replace(/\[\[poet]]/g, poet);
        chat = chat.replace(/\[\[verseStyle]]/g, style);
        if (!chat.includes('[[chunk]]')) chat += "\n\nAnalyze the following text:\n[[chunk]]";
        
        availablePrompts.push({ name: path.basename(file, '.json'), system, chat, style, poet });
    }
    if (!availablePrompts.length) throw new Error(`No valid prompts in ${PROMPTS_DIR}.`);
    return availablePrompts;
}

function parseGenerationOutput(text) {
    const sections = { verse: '', image: '', video: '', music_prompts: '' };
    let current = 'verse';
    
    const lines = text.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (/^(?:#+|\*\*|__)?\s*(?:Image Prompt|Visual Description)\s*(?:\*\*|__|:)?$/i.test(trimmed)) current = 'image';
        else if (/^(?:#+|\*\*|__)?\s*(?:Video Prompt|Motion Description)\s*(?:\*\*|__|:)?$/i.test(trimmed)) current = 'video';
        else if (/^(?:#+|\*\*|__)?\s*(?:Music\s*(?:&|and)\s*Audio|Audio Prompts|Music Prompts)\s*(?:\*\*|__|:)?$/i.test(trimmed)) current = 'music_prompts';
        else if (/^(?:#+|\*\*|__)?\s*Verse\s*(?:\d*)?\s*(?:\*\*|__|:)?$/i.test(trimmed)) current = 'verse';
        else {
            if (sections[current] !== undefined) sections[current] += line + '\n';
        }
    }

    const cleanedVerse = cleanVerseText(sections.verse);

    const result = {
        verse: cleanedVerse,
        image: sections.image.trim(),
        video: sections.video.trim(),
        music_tags: "",
        negative_tags: ""
    };

    if (sections.music_prompts) {
        const tagsMatch = sections.music_prompts.match(/tags:([\s\S]*?)(negative tags:|$)/i);
        const negativeMatch = sections.music_prompts.match(/negative tags:([\s\S]*)/i);
        if(tagsMatch) result.music_tags = tagsMatch[1].trim().replace(/\n/g, ' ');
        if(negativeMatch) result.negative_tags = negativeMatch[1].trim().replace(/\n/g, ' ');
    }

    if (!result.music_tags) result.music_tags = "baroque, orchestral, cello, harpsichord, distinct, high fidelity, cinematic";
    
    return result;
}

// --- GENERATION FUNCTIONS ---

async function generateWithFallback(modelNames, generationRequest) {
    let lastError;
    for (const modelName of modelNames) {
        try {
            console.log(`Attempting model: ${modelName}`);
            const model = genAI.getGenerativeModel({ model: modelName, generationConfig: { temperature: 1 } });
            const result = await model.generateContent(generationRequest);
            return result;
        } catch (error) {
            console.warn(`Model ${modelName} failed: ${error.message}`);
            lastError = error;
            if (error.message.includes('403') || error.message.toLowerCase().includes('forbidden')) continue;
            break;
        }
    }
    throw new Error(`All models failed. Last error: ${lastError?.message}`);
}

async function generateWithGrok(systemPrompt, userPrompt) {
    console.log(`Attempting Grok: ${GROK_MODEL_NAME}...`);
    try {
        const payload = {
            model: GROK_MODEL_NAME,
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
            temperature: 1.0,
        };
        if (useGrokSearch) {
            console.log("Grok Search ENABLED.");
            payload.search_parameters = { mode: "on", max_search_results: 5 };
        }
        const completion = await grokClient.chat.completions.create(payload);
        return { response: { text: () => completion.choices[0]?.message?.content || '' } };
    } catch (error) {
        console.error(`Grok failed: ${error.message}`);
        return { error: true, message: error.message };
    }
}

async function processOriginalImage(imageUrl, baseFilename) {
    if (!imageUrl) return "";
    try {
        let directImageUrl = imageUrl;
        if (imageUrl.includes('?url=')) directImageUrl = decodeURIComponent(imageUrl.substring(imageUrl.indexOf('?url=') + 5));
        
        const headers = { 'User-Agent': 'Mozilla/5.0', 'Referer': new URL(imageUrl).origin + '/' };
        const res = await axios.get(directImageUrl, { responseType: 'arraybuffer', timeout: 20000, headers });
        
        const ext = path.extname(new URL(directImageUrl).pathname).toLowerCase() || '.jpg';
        // FIX: Add timestamp hash to prevent overwriting
        const savedFilename = `${baseFilename}-og-image-${Date.now()}${ext}`;
        await fs.writeFile(path.join(OUTPUT_IMAGES_DIR, savedFilename), res.data);
        
        const mimeType = ext === '.png' ? 'image/png' : (ext === '.webp' ? 'image/webp' : 'image/jpeg');
        const result = await generateWithFallback(VISION_MODEL_NAMES, ["Compose a Shakespearean Sonnet for this image.", { inlineData: { data: Buffer.from(res.data, 'binary').toString("base64"), mimeType } }]);
        
        return `![](/images/${savedFilename})\n\n${result.response?.text?.()?.trim()}\n\n`;
    } catch (e) { return `<!-- Vision processing failed: ${e.message} -->\n`; }
}

async function analyzeYouTubeAudio(youtubeUrl) {
    console.log(`Analyzing Audio for: ${youtubeUrl}`);
    const tempPath = path.join(os.tmpdir(), `temp-audio-${Date.now()}.opus`);
    try {
        const args = ['--no-playlist', '-f', 'bestaudio/best', '-x', '--audio-format', 'opus', '-o', tempPath, youtubeUrl];
        if (fss.existsSync(YT_DLP_COOKIES_PATH)) args.unshift('--cookies', YT_DLP_COOKIES_PATH);
        
        await execFileAsync('yt-dlp', args);

        if (createSnippet) {
            const snippetPath = path.join(INPUT_AUDIO_DIR_JAMIFY, JAMIFY_CURRENT_INPUT_SONG);
            await new Promise((resolve, reject) => {
                ffmpeg(tempPath).setStartTime(SNIPPET_START_TIME_SECONDS).setDuration(SNIPPET_DURATION_SECONDS)
                .audioCodec('libmp3lame').audioBitrate('192k').toFormat('mp3')
                .on('end', resolve).on('error', reject).save(snippetPath);
            });
        }

        const audioData = await fs.readFile(tempPath);
        const prompt = `Analyze this audio. Part 1: Synopsis/Transcript. Part 2: Soundscape/Music/Voice Analysis. 
        ### Music Tags:
        Create a single line of comma-delimited tags for music generation (e.g., baroque, orchestral, folk).`;
        
        const result = await generateWithFallback(TEXT_MODEL_NAMES, [prompt, { inlineData: { data: audioData.toString("base64"), mimeType: "audio/opus" } }]);
        return { success: true, markdown: `\n<details><summary>YouTube Audio Analysis</summary><pre><code>${escapeHtml(result.response.text())}</code></pre></details>\n`, rawText: result.response.text() };
    } catch (e) { return { success: false, error: e.message }; }
    finally { try { await fs.unlink(tempPath); } catch {} }
}

// --- EXECUTION HANDLERS ---

async function executeComfyScript(scriptName, promptData) {
    const stateFile = path.join(os.tmpdir(), `state-${Date.now()}.json`);
    try {
        for (const [k, v] of Object.entries(promptData)) await fs.writeFile(k, v || '', 'utf8');
        const { stderr } = await execFileAsync('node', [path.join(__dirname, scriptName), '--state-file', stateFile]);
        if (stderr) console.warn(`[${scriptName}] Stderr:`, stderr);
        const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
        return { success: true, filename: state.filename, markdown: `\n![](/images/${state.filename})\n` }; 
    } catch (e) { return { success: false, error: e.message, markdown: `<!-- ${scriptName} Failed: ${e.message} -->` }; }
    finally { try { await fs.unlink(stateFile); } catch {} }
}

async function generateImageWithComfyUI(prompt) {
    const res = await executeComfyScript('run_flux_modified.js', { 'prompt.txt': prompt });
    if (res.success) res.markdown = `\n\n![Generated Image](/images/${res.filename})\n\n`;
    return { ...res, prompt };
}

async function generateVideoWithComfyUI(prompt) {
    const res = await executeComfyScript('t2v_modified.js', { 'prompt.txt': prompt.substring(0, 2000), 'negative_prompt.txt': 'blurry, distorted' });
    if (res.success) res.markdown = `\n\n<video controls width="100%"><source src="/images/${res.filename}" type="video/webm"></video>\n\n`;
    return { ...res, positivePrompt: prompt };
}

async function generateMusicWithComfyUI({ tags, lyrics, negative_tags }) {
    const res = await executeComfyScript('run_ace_step1_modified.js', { 'tags.txt': tags, 'lyrics.txt': lyrics, 'negative_tags.txt': negative_tags });
    if (res.success) res.markdown = `\n<audio controls src="/images/${res.filename}"></audio>\n`;
    return { ...res, prompts: { tags, lyrics } };
}

async function executeJamifyScript({ tags, timedLyricsJson, duration }) {
    if (!tags || !timedLyricsJson) return { success: false, markdown: "<!-- Jamify Skipped -->" };
    const id = `jamify-${Date.now()}`;
    const configPath = path.join(os.tmpdir(), `${id}.yaml`);
    
    try {
        const baseConfig = yaml.load(await fs.readFile(path.join(JAMIFY_PROJECT_PATH, 'configs', 'jam_infer.yaml'), 'utf8'));
        baseConfig.evaluation.vae_type = JAMIFY_VAE_TYPE;
        baseConfig.evaluation.num_style_secs = SNIPPET_DURATION_SECONDS;
        baseConfig.evaluation.use_prompt_style = JAMIFY_USE_PROMPT_STYLE;
        await fs.writeFile(configPath, yaml.dump(baseConfig), 'utf8');

        await fs.mkdir(path.join(JAMIFY_PROJECT_PATH, 'inputs'), {recursive:true});
        await fs.writeFile(path.join(JAMIFY_PROJECT_PATH, 'inputs', 'prompt.txt'), tags, 'utf8');
        await fs.writeFile(path.join(JAMIFY_PROJECT_PATH, 'inputs', 'timed_lyrics.json'), JSON.stringify(timedLyricsJson, null, 2), 'utf8');
        
        const inputData = [{ "id": id, "audio_path": `inputs/${useCurrentAudio ? JAMIFY_CURRENT_INPUT_SONG : JAMIFY_DEFAULT_INPUT_SONG}`, "lrc_path": "inputs/timed_lyrics.json", "duration": duration, "prompt_path": "inputs/prompt.txt" }];
        await fs.writeFile(path.join(JAMIFY_PROJECT_PATH, 'inputs', 'input.json'), JSON.stringify(inputData, null, 2), 'utf8');

        const cmd = `bash -c 'source "${path.join(JAMIFY_PROJECT_PATH, 'venv_py313/bin/activate')}" && export PYTHONPATH="${JAMIFY_PROJECT_PATH}/src:$PYTHONPATH" && cd ${JAMIFY_PROJECT_PATH} && python -c "import torch; torch.cuda.empty_cache()" && accelerate launch --mixed_precision=fp16 inference.py --config_path "${configPath}"'`;
        await execAsync(cmd, { cwd: __dirname });

        const genDir = path.join(JAMIFY_PROJECT_PATH, 'outputs', 'generated');
        const files = await fs.readdir(genDir);
        const wavFile = files.find(f => f.startsWith(id));
        if (!wavFile) throw new Error("No Jamify output found");

        const outName = `${id}.opus`;
        await new Promise((res, rej) => {
            ffmpeg(path.join(genDir, wavFile)).audioCodec('libopus').audioBitrate('128k').toFormat('opus')
            .on('end', res).on('error', rej).save(path.join(OUTPUT_IMAGES_DIR, outName));
        });

        return { success: true, markdown: `\n<audio controls src="/images/${outName}"></audio>\n`, prompts: { tags, duration, timedLyricsJson } };
    } catch (e) { return { success: false, markdown: `<!-- Jamify Failed: ${e.message} -->` }; }
    finally { try { await fs.unlink(configPath); } catch {} }
}

// --- MAIN PROCESSORS ---

async function processContent(content, selectedPrompt, context = {}) {
    // 1. Vision Analysis
    let visionOutput = "";
    if (context.imageUrl) {
        visionOutput = await processOriginalImage(context.imageUrl, context.baseFilename);
    }

    // 2. Audio Analysis
    let audioOutput = "", audioTags = "";
    if (context.audioUrl) {
        const analysis = await analyzeYouTubeAudio(context.audioUrl);
        if (analysis.success) {
            audioOutput = analysis.markdown;
            const match = analysis.rawText.match(/(?:Music Tags:?)\s*([\s\S]*?)(?=###|$)/i);
            if (match) audioTags = match[1].trim();
        }
    }

    // 3. Text Generation
    const maxChars = useGrok ? GROK_MAX_CHUNK_SIZE_CHARS : MAX_CHUNK_SIZE_CHARS;
    let processedText = content;
    if (processedText.length > maxChars) {
        console.log(`Truncating content from ${processedText.length} to ${maxChars} chars.`);
        processedText = processedText.substring(0, maxChars);
    }

    const userPrompt = selectedPrompt.chat.replace('[[chunk]]', processedText) + FORMAT_REMINDER;

    let genResult;
    if (useGrok) {
        genResult = await generateWithGrok(selectedPrompt.system, userPrompt);
    } else {
        const fullPrompt = `${selectedPrompt.system}\n\n${userPrompt}`;
        genResult = await generateWithFallback(TEXT_MODEL_NAMES, { contents: [{ role: "user", parts: [{ text: fullPrompt }] }] });
    }

    if (genResult.error || !genResult.response?.text) {
        console.error("Text generation failed or returned empty.");
        return;
    }

    const rawText = genResult.response.text();
    const parsed = parseGenerationOutput(rawText);

    // 4. Media Generation
    console.log("--- Starting Media Generation ---");
    
    // Lyric Prep - Use cleaned verse for logic
    const lyricStanza = parsed.verse.split(/\n\s*\n/).find(s => s.split('\n').length > 2) || parsed.verse;
    const cleanLyrics = unescapeHtml(lyricStanza).replace(/<[^>]+>/g, '').replace(/[\*_`#\[\]]/g, '').trim();
    
    // Timed Lyrics
    const timedLyrics = [];
    let t = 15.5; 
    cleanLyrics.split('\n').forEach(line => {
        line.trim().split(/\s+/).forEach(w => {
            const word = w.replace(/[^\w'-]/g, '');
            if(word) { timedLyrics.push({start: t, end: t+0.5, word}); t += 0.5; }
        });
        t += 0.25;
    });

    const imgGen = await generateImageWithComfyUI(parsed.image || "A conceptual visualization of extracted essence, high fidelity.");
    const vidGen = await generateVideoWithComfyUI(parsed.video || "Abstract motion of vapors and light, 4k resolution.");
    
    const musicTags = parsed.music_tags || audioTags || "cinematic, orchestral, baroque, intense";
    const musGen = await generateMusicWithComfyUI({ tags: musicTags, lyrics: cleanLyrics, negative_tags: ACE_STEP_NEGATIVE_TAGS });

    if (imgGen.success || vidGen.success || musGen.success) await new Promise(r => setTimeout(r, 30000));

    const jamGen = await executeJamifyScript({ 
        tags: musicTags, 
        timedLyricsJson: timedLyrics.length ? timedLyrics : null, 
        duration: t + 15 
    });

    // 5. Markdown Assembly
    const frontMatter = [];
    if (imgGen.success) frontMatter.push(`image: /images/${imgGen.filename}`);
    if (vidGen.success) frontMatter.push(`video: /images/${vidGen.filename}`);
    if (musGen.success) frontMatter.push(`audio: /images/${musGen.filename}`);

    let sourceSection = "";
    if (Array.isArray(context.sourceList)) {
        sourceSection = `\n**Sources:**\n${context.sourceList.map(s => `- [${s.title}](${s.url || '#'})`).join('\n')}\n`;
    } else {
        sourceSection = `Source: [${context.title}](${context.sourceLink || '#'})`;
    }

    const textModelInUse = useGrok ? `X.ai ${GROK_MODEL_NAME}` : TEXT_MODEL_NAMES.join(' -> ');

    const md = `---
title: "${escapeHtml(context.title)}"
author: ${useGrok ? "Grok" : "Gemini"} + ComfyUI
${frontMatter.join('\n')}
---
${sourceSection}
<hr>
### Verse
<pre>${escapeHtml(parsed.verse)}</pre>
<hr>

### Generated Media
**Image:** ${imgGen.markdown}
<details><summary>Prompt</summary>${escapeHtml(imgGen.prompt)}</details>

**Video:** ${vidGen.markdown}
<details><summary>Prompt</summary>${escapeHtml(vidGen.positivePrompt)}</details>

**Music (Ace-Step):** ${musGen.markdown}
<details><summary>Ace-Step Details</summary>
<strong>Tags:</strong><pre><code>${escapeHtml(musGen.prompts?.tags)}</code></pre>
<strong>Lyrics Used:</strong><pre><code>${escapeHtml(musGen.prompts?.lyrics)}</code></pre>
</details>

**Music (Jamify):** ${jamGen.markdown}
<details><summary>Jamify Details</summary>
<strong>Prompt:</strong><pre><code>${escapeHtml(jamGen.prompts?.tags)}</code></pre>
<strong>JSON Payload:</strong><pre><code class="language-json">${escapeHtml(JSON.stringify(jamGen.prompts?.timedLyricsJson, null, 2))}</code></pre>
<strong>Duration:</strong><pre><code>${jamGen.prompts?.duration}s</code></pre>
</details>

<hr>
### Analysis

${visionOutput}
${audioOutput}

<details><summary>Models & Prompt</summary>
<p><strong>Text:</strong> ${textModelInUse}</p>
<p><strong>Vision:</strong> ${VISION_MODEL_NAMES.join(' -> ')}</p>
<p><strong>Prompt Name:</strong> ${selectedPrompt.name}</p>
<p><strong>System Prompt:</strong></p>
<pre><code>${escapeHtml(selectedPrompt.system)}</code></pre>
<p><strong>Chat Prompt:</strong></p>
<pre><code>${escapeHtml(selectedPrompt.chat)}</code></pre>
</details>
`;

    // Truncate slug to 50 chars to prevent ENAMETOOLONG errors on file systems
const safeSlug = slugify(context.title).substring(0, 50);
const outPath = path.join(OUTPUT_POSTS_DIR, `${safeSlug}-${Date.now()}.md`);
    await fs.writeFile(outPath, md);
    console.log(`Generated: ${outPath}`);
}

// --- ENTRY POINTS ---

async function main() {
    await fs.mkdir(OUTPUT_POSTS_DIR, { recursive: true });
    await fs.mkdir(OUTPUT_IMAGES_DIR, { recursive: true });
    await fs.mkdir(JSON_COPY_DIR, { recursive: true });

    const prompts = await loadAndPreparePrompts();
    const selectedPrompt = prompts[Math.floor(Math.random() * prompts.length)];
    console.log(`Selected Prompt: ${selectedPrompt.name}`);

    if (useGroupMode) {
        console.log(">>> MODE: GROUP <<<");
        const files = await fs.readdir(INPUT_GROUP_DIR);
        let combinedText = "";
        let firstImg = null, firstAudio = null, titles = [];
        let sourceList = [];
        
        for (const f of files.filter(x => x.endsWith('.json'))) {
            const filePath = path.join(INPUT_GROUP_DIR, f);
            const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
            const og = data.ogResult || {};
            const title = og.ogTitle || data.title || f;
            
            titles.push(title);
            sourceList.push({ title: title, url: og.ogUrl });
            
            if (!firstImg) firstImg = og.ogImage?.[0]?.url;
            if (!firstAudio && og.ogUrl?.includes('youtu')) firstAudio = og.ogUrl;
            
            combinedText += `\n--- SOURCE: ${title} ---\n${removeBoilerplate(og.ogDescription + " " + (data.ogHTML || ""))}\n`;

            await fs.writeFile(path.join(JSON_COPY_DIR, f), JSON.stringify(data, null, 2));
            console.log(`Copied ${f} to ${JSON_COPY_DIR}`);
        }

        await processContent(combinedText, selectedPrompt, {
            title: `Group Analysis: ${titles.slice(0,2).join(' & ')}`,
            sourceList: sourceList, 
            imageUrl: firstImg,
            audioUrl: firstAudio,
            baseFilename: "group"
        });

    } else {
        console.log(">>> MODE: SINGLE <<<");
        const files = await fs.readdir(INPUT_DATA_DIR);
        for (const f of files.filter(x => x.endsWith('.json'))) {
            const filePath = path.join(INPUT_DATA_DIR, f);
            const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
            const og = data.ogResult || {};
            const content = removeBoilerplate([og.ogTitle, og.ogDescription, data.ogHTML].join('\n'));
            
            await fs.writeFile(path.join(JSON_COPY_DIR, f), JSON.stringify(data, null, 2));

            await processContent(content, selectedPrompt, {
                title: og.ogTitle || f,
                sourceLink: og.ogUrl, 
                imageUrl: og.ogImage?.[0]?.url,
                audioUrl: og.ogUrl?.includes('youtu') ? og.ogUrl : null,
                baseFilename: path.basename(f, '.json')
            });
        }
    }
}

main().catch(console.error);
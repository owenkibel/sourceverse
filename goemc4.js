const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');
const os = require('os');
const util = require('util');
const { execFile } = require('child_process');
const execFileAsync = util.promisify(execFile);

const { GoogleGenerativeAI, GoogleGenerativeAIError, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const axios = require('axios');

const ffmpeg = require('fluent-ffmpeg');
const streamifier = require('streamifier');
const { GoogleGenAI } = require('@google/genai');
const { createWriteStream } = require("fs");
const { Readable } = require("stream");

// --- Model Configuration ---
const TEXT_MODEL_NAME = "gemini-2.5-flash-lite";
const IMAGE_GEN_MODEL_NAME = "gemini-2.5-flash-image-preview";
const VISION_MODEL_NAME = "gemini-2.5-flash-lite";

const INPUT_DATA_DIR = 'ogs_data';
const JSON_COPY_DIR = 'json';
const PROMPTS_DIR = path.join(__dirname, 'prompts');
const OUTPUT_POSTS_DIR = 'posts';
const OUTPUT_IMAGES_DIR = 'images';
const PROMPT_STATE_FILE = path.join(__dirname, 'gemini.txt');

const MAX_CHUNK_TOKEN_ESTIMATE = 500000;
const AVG_CHARS_PER_TOKEN = 4;
const MAX_CHUNK_SIZE_CHARS = MAX_CHUNK_TOKEN_ESTIMATE * AVG_CHARS_PER_TOKEN;

const apiKey = process.env.API_KEY;
if (!apiKey) {
    console.error("FATAL: API_KEY environment variable for Google AI is not set.");
    process.exit(1);
}
const genAI = new GoogleGenerativeAI(apiKey);

const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

let textModel, visionModel;
let googleGenAIClient;
let logMessage;

try {
    textModel = genAI.getGenerativeModel({
        model: TEXT_MODEL_NAME,
        safetySettings,
        generationConfig: { temperature: 1 }
    });
    visionModel = genAI.getGenerativeModel({ model: VISION_MODEL_NAME, safetySettings });
    console.log(`Models initialized (via @google/generative-ai):`);
    console.log(`- Text Model (${TEXT_MODEL_NAME}, temp: 1)`);
    console.log(`- Vision Model (${VISION_MODEL_NAME})`);
    console.log(`- Image Gen Model (${IMAGE_GEN_MODEL_NAME})`);
} catch (modelError) {
    console.error("FATAL: Error initializing Google AI models:", modelError.message);
    process.exit(1);
}

let currentInputFile = '';
let currentInputPath = '';
let availablePrompts = [];
let useLocalAudioProcessing = false;
let localAudioStartTime = '0';

// ... (executeComfyScript, loadPromptFile, loadAndPreparePrompts, and other helpers remain unchanged)
async function executeComfyScript(scriptName, promptData) {
    const stateFileName = `temp-state-${path.basename(scriptName, '.js')}-${Date.now()}.json`;
    const stateFilePath = path.join(os.tmpdir(), stateFileName);
    const scriptPath = path.join(__dirname, scriptName);
    const args = [scriptPath, '--state-file', stateFilePath];
    try {
        console.log(`Writing prompts for ${scriptName}...`);
        for (const [fileName, content] of Object.entries(promptData)) {
            await fs.writeFile(fileName, content || '', 'utf8');
        }
        console.log(`Executing ComfyUI script: node ${scriptName}`);
        const { stdout, stderr } = await execFileAsync('node', args);
        if (stderr) {
            console.warn(`[${scriptName}] Stderr:\n`, stderr);
        }
        const state = JSON.parse(await fs.readFile(stateFilePath, 'utf8'));
        console.log(`[${scriptName}] successfully generated: ${state.filename}`);
        return { success: true, path: state.savedFilePath, filename: state.filename };
    } catch (error) {
        console.error(`\n--- ERROR executing ${scriptName} ---`, error);
        return { success: false, error: error.message };
    } finally {
        try {
            await fs.unlink(stateFilePath);
        } catch (cleanupError) {
            if (cleanupError.code !== 'ENOENT') {
                console.error(`Failed to clean up temporary state file ${stateFilePath}:`, cleanupError);
            }
        }
    }
}
async function loadPromptFile(filePath) { try { const fileContent = await fs.readFile(filePath, 'utf8'); return JSON.parse(fileContent); } catch (error) { console.error(`Error loading or parsing prompt from ${filePath}:`, error); throw new Error(`Failed to load/parse prompt file: ${filePath}.`); } }
async function loadAndPreparePrompts() { availablePrompts = []; try { const promptFiles = await fs.readdir(PROMPTS_DIR); for (const file of promptFiles) { if (path.extname(file).toLowerCase() !== '.json') continue; const filePath = path.join(PROMPTS_DIR, file); const promptData = await loadPromptFile(filePath); if (!promptData.system || !promptData.chat) continue; let systemPrompt = promptData.system; let chatPrompt = promptData.chat; const style = promptData.style?.[Math.floor(Math.random() * promptData.style.length)] || ""; const poet = promptData.poet?.[Math.floor(Math.random() * promptData.poet.length)] || ""; systemPrompt = systemPrompt.replace(/\[\[verseStyle]]/g, style).replace(/\[\[poet]]/g, poet); chatPrompt = chatPrompt.replace(/\[\[poet]]/g, poet); if (!chatPrompt.includes('[[chunk]]')) chatPrompt += "\n\nAnalyze the following text:\n[[chunk]]"; availablePrompts.push({ name: path.basename(file, '.json'), system: systemPrompt, chat: chatPrompt, style, poet }); } if (availablePrompts.length === 0) throw new Error(`No valid prompt files found in ${PROMPTS_DIR}.`); console.log(`Successfully loaded ${availablePrompts.length} prompts.`); } catch (error) { console.error("Error loading prompts:", error); throw error; } }
function getNextPromptIndexSync() { try { if (availablePrompts.length === 0) return 0; const data = fss.readFileSync(PROMPT_STATE_FILE, 'utf-8'); const index = parseInt(data.trim(), 10); return (isNaN(index) || index < 0) ? 0 : (index + 1) % availablePrompts.length; } catch { return 0; } }
function setPromptIndexSync(index) { try { fss.writeFileSync(PROMPT_STATE_FILE, String(index), 'utf-8'); } catch (error) { console.error(`Error writing prompt state file:`, error); } }
function transformInputJson(input) { const newObject = { name: input.title || 'Untitled', url: input.source || '', ogResult: { ogTitle: input.title || 'Untitled', ogDescription: input.description || '', ogUrl: input.source || '', ogImage: [] }, ogHTML: input.content || '', ogLength: (input.content || '').length, youtube: input.youtube, }; if (input.images?.length > 0) { const getImageSizeRank = (url) => { try { const name = new URLSearchParams(new URL(url).search).get('name'); if (name) { if (name.toLowerCase() === 'orig') return 10000; if (name.toLowerCase() === 'large') return 5000; const dimMatch = name.match(/^(\d+)x(\d+)$/); if (dimMatch) return parseInt(dimMatch[1]) * parseInt(dimMatch[2]); } } catch { } if (url.includes('_bigger.')) return 75; if (url.includes('_normal.')) return 50; return 0; }; const candidateImages = input.images .filter(imgUrl => typeof imgUrl === 'string' && imgUrl && !/svg|profile_images|avatar|profile_banners|spacer|blank|1x1/i.test(imgUrl)) .map(imgUrl => ({ url: imgUrl, isJpeg: /\.(jpg|jpeg)(\?.*)?$/i.test(imgUrl) || /format=(jpg|jpeg)/i.test(imgUrl), rank: getImageSizeRank(imgUrl) })) .sort((a, b) => (b.rank !== a.rank) ? (b.rank - a.rank) : (b.isJpeg - a.isJpeg)); if (candidateImages.length > 0) newObject.ogResult.ogImage.push({ url: candidateImages[0].url }); } return newObject; }
async function generateImageWithComfyUI(prompt) { if (!prompt?.trim()) { return { success: false, markdown: "<!-- Image generation skipped: No valid prompt -->", prompt: prompt || "" }; } const result = await executeComfyScript('run_flux_modified.js', { 'prompt.txt': prompt }); if (result.success) { const relativePath = `/images/${result.filename}`; return { success: true, markdown: `\n\n![Generated Image](${relativePath})\n\n`, prompt }; } else { return { success: false, markdown: `\n\n<!-- ComfyUI Image Generation Failed: ${escapeHtml(result.error)} -->\n\n`, prompt }; } }
async function generateVideoWithComfyUI(positivePrompt, negativePrompt = "blurry, low quality") { if (!positivePrompt?.trim()) { return { success: false, markdown: "<!-- Video generation skipped: No valid prompt -->", positivePrompt: positivePrompt || "", negativePrompt }; } const result = await executeComfyScript('t2v_modified.js', { 'prompt.txt': positivePrompt, 'negative_prompt.txt': negativePrompt }); if (result.success) { const relativePath = `/images/${result.filename}`; return { success: true, markdown: `\n\n<video controls width="100%"><source src="${relativePath}" type="video/webm">Your browser does not support the video tag.</video>\n\n`, positivePrompt, negativePrompt }; } else { return { success: false, markdown: `\n\n<!-- ComfyUI Video Generation Failed: ${escapeHtml(result.error)} -->\n\n`, positivePrompt, negativePrompt }; } }
async function generateMusicWithComfyUI(prompts) { const { tags, lyrics, negative_tags } = prompts; if (!tags?.trim() || !lyrics?.trim()) { return { success: false, markdown: "<!-- Music generation skipped: Missing tags or lyrics -->", prompts }; } const result = await executeComfyScript('run_ace_step1_modified.js', { 'tags.txt': tags, 'lyrics.txt': lyrics, 'negative_tags.txt': negative_tags || 'low quality, bad audio, distorted' }); if (result.success) { const relativePath = `/images/${result.filename}`; return { success: true, markdown: `\n<audio controls src="${relativePath}"></audio>\n`, prompts }; } else { return { success: false, markdown: `\n<p><strong>Music generation failed.</strong> Error: ${escapeHtml(result.error)}</p>`, prompts }; } }
// ... (encodePcmToWebmOpus, urlToGenerativePart, processOriginalImage, and YouTube analysis functions remain unchanged)
async function encodePcmToWebmOpus(outputFilename, pcmAudioBuffer, inputChannels = 1, inputSampleRate = 24000, inputSampleFormat = 's16le', options = {}) { const { outputSampleRate, audioEnhancement = { type: 'none' } } = options; return new Promise((resolve, reject) => { const pcmStream = streamifier.createReadStream(pcmAudioBuffer); const command = ffmpeg().input(pcmStream).inputOptions([`-f ${inputSampleFormat}`, `-ar ${inputSampleRate}`, `-ac ${inputChannels}`]); let finalOutputChannels = inputChannels; let filterGraph = []; let currentAudioStreamLabel = '[0:a]'; const needsStereo = ['pseudoStereo', 'pingPongEcho'].includes(audioEnhancement.type); if (inputChannels === 1 && needsStereo) { filterGraph.push(`${currentAudioStreamLabel}asplit[l][r]`); filterGraph.push(`[l][r]amerge=inputs=2[stereo_pre_effect]`); currentAudioStreamLabel = '[stereo_pre_effect]'; finalOutputChannels = 2; } else if (inputChannels >= 2) { finalOutputChannels = 2; } switch (audioEnhancement.type) { case 'pseudoStereo': const delayMs = audioEnhancement.delayMs || 25; filterGraph.push(`${currentAudioStreamLabel}channelsplit=channel_layout=stereo[L][R]`); filterGraph.push(`[R]adelay=${delayMs}|${delayMs}[Rd]`); filterGraph.push(`[L][Rd]amerge=inputs=2[aout]`); currentAudioStreamLabel = '[aout]'; logMessage = `FFMPEG: Pseudo-stereo audio encoded to ${outputFilename}`; break; case 'pingPongEcho': const pingPongDelay = audioEnhancement.delayMs || 400; const pingPongDecay = audioEnhancement.decay || 0.6; filterGraph.push(`${currentAudioStreamLabel}asplit=4[orig][delay1_src][delay2_src][delay3_src]`); filterGraph.push(`[orig]pan=stereo|c0=c0|c1=0.1*c0[L_direct]`); filterGraph.push(`[delay1_src]adelay=${pingPongDelay}[d1]`); filterGraph.push(`[d1]volume=${pingPongDecay}[v1]`); filterGraph.push(`[v1]pan=stereo|c0=0.1*c0|c1=c0[R_bounce1]`); filterGraph.push(`[delay2_src]adelay=${2 * pingPongDelay}[d2]`); filterGraph.push(`[d2]volume=${pingPongDecay * pingPongDecay}[v2]`); filterGraph.push(`[v2]pan=stereo|c0=c0|c1=0.1*c0[L_bounce2]`); filterGraph.push(`[delay3_src]adelay=${3 * pingPongDelay}[d3]`); filterGraph.push(`[d3]volume=${pingPongDecay * pingPongDecay * pingPongDecay}[v3]`); filterGraph.push(`[v3]pan=stereo|c0=0.1*c0|c1=c0[R_bounce3]`); filterGraph.push(`[L_direct][R_bounce1][L_bounce2][R_bounce3]amix=inputs=4[aout]`); currentAudioStreamLabel = '[aout]'; finalOutputChannels = 2; logMessage = `FFMPEG: True ping-pong stereo echo applied to ${outputFilename}`; break; } if (filterGraph.length > 0) { command.complexFilter(filterGraph.join('; ')); command.outputOptions([`-map ${currentAudioStreamLabel}`]); } command.audioChannels(finalOutputChannels); if (outputSampleRate && outputSampleRate !== inputSampleRate) { command.audioFrequency(outputSampleRate); logMessage += ` (resampled to ${outputSampleRate}Hz)`; } command.audioCodec('libopus').format('webm').save(outputFilename).on('end', () => { console.log(`${logMessage}\nFFMPEG: Audio successfully encoded to ${outputFilename}`); resolve(`File saved as ${outputFilename}`); }).on('error', (err) => { console.error("FFMPEG Error:", err.message); reject(err); }); }); }
async function urlToGenerativePart(url, mimeType = "image/jpeg") { console.log(`Downloading image for vision: ${url}`); try { const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 }); return { inlineData: { data: Buffer.from(res.data, 'binary').toString("base64"), mimeType } }; } catch (error) { console.error(`Failed to download ${url}: ${error.message}`); return null; } }
async function processOriginalImage(imageUrl) { if (!imageUrl) return ""; console.log(`Processing original image with vision: ${imageUrl}`); let imagePart = null; try { let mimeType = "image/jpeg"; const ext = path.extname(new URL(imageUrl).pathname).toLowerCase(); if (ext === '.png') mimeType = "image/png"; else if (ext === '.webp') mimeType = "image/webp"; imagePart = await urlToGenerativePart(imageUrl, mimeType); if (!imagePart) throw new Error("Failed to download/prepare image part."); } catch (prepError) { return `<!-- Vision skip: Could not prepare ${imageUrl}: ${prepError.message} -->\n`; } try { const result = await visionModel.generateContent(["Compose a Shakespearean Sonnet for this image.", imagePart]); const sonnet = result.response?.text?.(); if (!sonnet) return `<!-- Vision skip: No content for ${imageUrl}. -->\n`; return `### Sonnet for Original Image\n\n![](${encodeURI(imageUrl)})\n\n${sonnet.trim()}\n\n`; } catch (error) { console.error(`Vision error (${imageUrl}):`, error.message); return "<!-- Vision processing failed -->\n"; } }
const YOUTUBE_ANALYSIS_PROMPT_UNIFIED = ` You will be provided with context, which could be an audio track, a video, or just text from an article. Your task is to perform a multi-part analysis based on the available information. ### Part 1: Synopsis & Transcript - **If Video/Audio is present:** Create an accurate and comprehensive transcript of all spoken content. Transcribe all dialogue, speeches, and lyrics. Do not summarize. Identify and label different speakers. Also, provide a concise synopsis of the video's message and imagery. - **If only Text is present:** Summarize the key points and themes of the text. ### Part 2: Detailed Analysis - **If Video/Audio is present:** Provide a detailed analysis of the non-speech audio elements. Describe the soundscape (ambient noise, effects), music (genre, instrumentation, mood), and voice quality (tone, emotion). - **If only Text is present:** This section can be omitted. ### Part 3: Music Generation Prompt **This is the most important part. Always generate this section, regardless of the input type.** Create a prompt for a music generation model under the heading "### Music Tags:". The prompt must be a single line of comma-delimited descriptive tags. - **Source of Inspiration:** - If music is present in the source audio, base the tags on that music. - If there is no music, or if the source is a text article, **imagine and create a prompt for a new piece of music that would be a fitting soundtrack for the content.** The mood and theme of the music should reflect the topic of the article or video. - **Content:** The prompt should be detailed (approx. 150 words) and include instrumentation, genre, era, mood, tempo, dynamics, and overall theme. - **Structure:** Start with general terms and become progressively more specific. - **Constraint:** If a specific composer or artist is identifiable or relevant, mention their name ONLY at the very end of the prompt. - **Example:** cinematic, orchestral, modern classical, inspirational, uplifting, slow tempo, building intensity, string section with piano melody, french horns, subtle electronic elements, wide dynamic range from pianissimo to fortissimo, emotional, hopeful, creating a sense of wonder and achievement. `;
async function performYouTubeAnalysis(audioPart, youtubeUrl, startTime = 'N/A') { console.log(`Requesting unified YouTube analysis for ${youtubeUrl}...`); try { const result = await textModel.generateContent([YOUTUBE_ANALYSIS_PROMPT_UNIFIED, audioPart]); const analysisText = result.response.text(); const markdown = `\n### YouTube Audio Analysis (from ${startTime})\n<pre><code>${escapeHtml(analysisText)}</code></pre>\n`; return { success: true, markdown: markdown, rawText: analysisText }; } catch (error) { console.error(`Error during unified YouTube analysis for ${youtubeUrl}:`, error); return { success: false, error: error.message }; } }
async function analyzeYouTubeAudioLocally(youtubeUrl, startTime = '0', duration = 600) { console.log(`Performing local audio analysis for: ${youtubeUrl} (start: ${startTime}s, duration: ${duration}s).`); const tempFileName = `temp-audio-${Date.now()}.opus`; const tempFilePath = path.join(os.tmpdir(), tempFileName); try { const ffmpegArgs = `-ss ${startTime} -t ${duration}`; const args = ['-f', 'bestaudio/best', '-x', '--audio-format', 'opus', '--ppa', `ffmpeg:${ffmpegArgs}`, '-o', tempFilePath, youtubeUrl]; console.log(`Executing command: yt-dlp ${args.join(' ')}`); const { stdout, stderr } = await execFileAsync('yt-dlp', args); if (stderr) console.warn('yt-dlp stderr output:\n', stderr); console.log('yt-dlp stdout output:\n', stdout); const audioFileBuffer = await fs.readFile(tempFilePath); const audioPart = { inlineData: { data: audioFileBuffer.toString("base64"), mimeType: "audio/opus" } }; return await performYouTubeAnalysis(audioPart, youtubeUrl, `${startTime}s`); } catch (error) { console.error(`An error occurred during local YouTube audio analysis for ${youtubeUrl} at ${startTime}s:`, error); return { success: false, error: error.message }; } finally { try { await fs.unlink(tempFilePath); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') { console.error(`Failed to delete temporary file ${tempFilePath}:`, cleanupError); } } } }
async function analyzeYouTubeAudio(youtubeUrl) { if (useLocalAudioProcessing) { console.log("`--local-audio` flag detected. Processing audio in 10-minute chunks."); const CHUNK_DURATION_SECONDS = 600; const MAX_CHUNKS = 6; let currentStartTime = parseInt(localAudioStartTime, 10) || 0; let combinedMarkdown = ""; let combinedRawText = ""; let hasFailures = false; for (let i = 0; i < MAX_CHUNKS; i++) { console.log(`--- Processing Audio Chunk ${i + 1} of ${MAX_CHUNKS} (starts at ${currentStartTime}s) ---`); const result = await analyzeYouTubeAudioLocally(youtubeUrl, currentStartTime, CHUNK_DURATION_SECONDS); if (result.success) { combinedMarkdown += result.markdown; combinedRawText += (result.rawText || "") + "\n\n"; } else { hasFailures = true; const errorMessage = result.error || 'Unknown error'; if (errorMessage.includes('Invalid start time') || errorMessage.includes('Conversion failed')) { console.log(`Reached the end of the video at chunk ${i + 1}. Stopping analysis.`); break; } combinedMarkdown += `\n### YouTube Audio Analysis (Chunk at ${currentStartTime}s)\n<p><strong>Analysis for this chunk failed.</strong></p>\n<p><em>Error:</em> ${escapeHtml(errorMessage)}</p>\n`; } currentStartTime += CHUNK_DURATION_SECONDS; await new Promise(resolve => setTimeout(resolve, 2000)); } return { success: !hasFailures, markdown: combinedMarkdown || "All audio chunks failed to process.", rawText: combinedRawText }; } console.log(`Analyzing YouTube audio directly from URL: ${youtubeUrl}`); try { const audioPart = { fileData: { fileUri: youtubeUrl, mimeType: "video/mp4" } }; return await performYouTubeAnalysis(audioPart, youtubeUrl, 'start'); } catch (error) { console.error(`An error occurred during direct YouTube audio analysis for ${youtubeUrl}:`, error); return { success: false, error: error.message }; } }
function unescapeHtml(text) { if (typeof text !== 'string') return text == null ? '' : String(text); return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&nbsp;/g, ' '); }

/**
 * NEW: Gently cleans verse text for the music generation model, preserving line breaks.
 * @param {string} text The text to clean.
 * @returns {string} The cleaned text suitable for lyrics.
 */
function cleanLyricsForMusicGen(text) {
    if (typeof text !== 'string') return '';
    let cleaned = unescapeHtml(text);
    // Remove markdown formatting but keep the text content
    cleaned = cleaned.replace(/<[^>]+>/g, ''); // Strip HTML tags
    cleaned = cleaned.replace(/[\*_`#\[\]\(\)]/g, ''); // Strip markdown characters
    // Normalize line endings and trim each line, but preserve them
    cleaned = cleaned.split('\n').map(line => line.trim()).join('\n');
    return cleaned.trim();
}

/**
 * NEW: Extracts the first 1-2 stanzas of verse, avoiding prose preambles.
 * @param {string} fullVerse The complete verse output from the model.
 * @returns {string} A snippet of verse (4-12 lines) suitable for lyrics.
 */
function extractLyricStanza(fullVerse) {
    if (!fullVerse || typeof fullVerse !== 'string') return '';

    // Split the text into stanzas based on one or more empty lines.
    const stanzas = fullVerse.trim().split(/\n\s*\n/);

    // Filter for actual stanzas (more than one line) to discard prose headings or single lines.
    const potentialStanzas = stanzas.filter(s => s.trim().split('\n').length > 1);

    if (potentialStanzas.length === 0) {
        // Fallback: If no multi-line stanzas are found, use the first non-empty block.
        return stanzas.find(s => s.trim()) || '';
    }

    let selectedLyrics = '';
    let lineCount = 0;
    const targetLines = 8; // Aim for around 8 lines

    for (const stanza of potentialStanzas) {
        const linesInStanza = stanza.trim().split('\n');
        selectedLyrics += (selectedLyrics ? '\n\n' : '') + linesInStanza.join('\n');
        lineCount += linesInStanza.length;
        // Stop if we have enough lines (e.g., after 1 or 2 stanzas)
        if (lineCount >= targetLines) {
            break;
        }
    }
    
    console.log(`Extracted ${lineCount} lines for lyrics.`);
    return selectedLyrics;
}


async function processSingleFile(inputFile, selectedPrompt) {
    currentInputFile = inputFile; 
    currentInputPath = path.join(INPUT_DATA_DIR, inputFile);
    const baseFilename = path.basename(inputFile, '.json');
    console.log(`\n--- Processing: ${inputFile} with Prompt: ${selectedPrompt.name} ---`);

    try {
        // --- STEP 1: DATA LOADING & PREPARATION ---
        let inputData = JSON.parse(await fs.readFile(currentInputPath, 'utf8'));
        if (inputData.content && !inputData.ogResult) inputData = transformInputJson(inputData);
        else if (!inputData.ogResult) { console.warn(`Skipping ${inputFile}: Unknown structure.`); return; }
        
        inputData.ogResult = inputData.ogResult || {};
        inputData.ogResult.ogTitle = inputData.ogResult.ogTitle || inputData.name || 'Untitled';
        await fs.writeFile(path.join(JSON_COPY_DIR, inputFile), JSON.stringify(inputData, null, 2));
        
        const originalImageUrl = inputData.ogResult.ogImage?.[0]?.url || inputData.ogResult.ogImage?.[0];
        let fullTextContent = [ inputData.ogResult?.ogUrl, inputData.ogResult?.ogTitle, inputData.ogResult?.ogDescription, inputData.youtube?.subtitles ].filter(Boolean).join('\n');
        const articleBody = inputData.ogResult.jsonLD?.find(item => item.articleBody)?.articleBody;
        if (articleBody) fullTextContent += `\n\n<blockquote cite="${inputData.ogResult?.ogUrl || ''}">JSON-LD:\n${escapeHtml(articleBody)}</blockquote>`;
        const cleanedHtml = (inputData.ogHTML || '').replace(/<style[^>]*>.*?<\/style>|<script[^>]*>.*?<\/script>|<[^>]+>/gis, ' ').replace(/\s{2,}/g, ' ').trim();
        if (cleanedHtml) fullTextContent += `\n\nPage Content:\n${cleanedHtml}`;
        fullTextContent = fullTextContent.trim();
        if (!fullTextContent) { console.warn(`Skipping ${inputFile}: No text content.`); return; }

        // --- STEP 2: GEMINI TEXT/VISION API CALLS ---
        let youtubeAnalysisPromise = Promise.resolve(null);
        const sourceUrl = inputData.ogResult.ogUrl;
        if (sourceUrl && (useLocalAudioProcessing || /youtube\.com|youtu\.be/i.test(sourceUrl))) {
            const cleanUrl = sourceUrl.replace('music.youtube.com', 'youtube.com');
            console.log(`Audio analysis triggered for: ${cleanUrl}`);
            youtubeAnalysisPromise = analyzeYouTubeAudio(cleanUrl);
        }

        const textChunks = [];
        for (let i = 0; i < fullTextContent.length; i += MAX_CHUNK_SIZE_CHARS) textChunks.push(fullTextContent.substring(i, i + MAX_CHUNK_SIZE_CHARS));
        if (textChunks.length === 0) { console.warn(`Skipping ${inputFile}: No text chunks from content.`); return; }

        const textApiPromises = textChunks.map((chunk) => {
            const userPrompt = selectedPrompt.chat.replace('[[chunk]]', chunk);
            const fullApiPrompt = `${selectedPrompt.system}\n\n${userPrompt}`;
            return textModel.generateContent({ contents: [{ role: "user", parts: [{ text: fullApiPrompt }] }], generationConfig: { maxOutputTokens: 8192 } }).catch(err => ({ error: true, message: err.message }));
        });

        const [imageSonnetResult, youtubeAnalysisResult, ...textApiResults] = await Promise.all([ processOriginalImage(originalImageUrl), youtubeAnalysisPromise, ...textApiPromises ]);

        // --- STEP 3: PARSE GEMINI'S RESPONSE FOR ALL PROMPTS ---
        let combinedVerseOutput = "", toc = "## Table of Contents\n";
        const extractedImagePrompts = [];
        const extractedVideoPrompts = [];
        const extractedMusicTags = [];
        const extractedNegativeMusicTags = [];
        let verseForLyrics = "";

        if (youtubeAnalysisResult && youtubeAnalysisResult.success && youtubeAnalysisResult.rawText) {
            const youtubeText = youtubeAnalysisResult.rawText;
            let inMusicSection = false;
            let currentMusicTags = '';
            for (const line of youtubeText.split('\n')) {
                if (/^\s*[\*#]+\s*.*(music|audio).*(prompt|tags)\s*[\*:]*$/i.test(line)) {
                    inMusicSection = true;
                    const contentAfterHeader = line.replace(/^\s*[\*#]+\s*.*(music|audio).*(prompt|tags)\s*[\*:]*/i, '').trim();
                    if (contentAfterHeader) currentMusicTags += contentAfterHeader + ' ';
                    continue;
                }
                if (inMusicSection) {
                    if (/^\s*[\*#]+/.test(line)) { inMusicSection = false; break; }
                    currentMusicTags += line.trim() + ' ';
                }
            }
            if (currentMusicTags.trim()) {
                console.log("Found music prompt from YouTube audio analysis.");
                extractedMusicTags.push(currentMusicTags.replace(/\s+/g, ' ').trim());
            }
        }

        textApiResults.forEach((result, index) => {
            const chunkNum = index + 1;
            toc += `- [Verse ${chunkNum}](#v${chunkNum})\n`;
            if (result.error) { combinedVerseOutput += `<h3 id="v${chunkNum}">Verse ${chunkNum}</h3><p><em>Error: ${result.message}</em></p>\n`; return; }
            
            const messageContent = result.response?.text?.()?.trim();
            if (!messageContent) { combinedVerseOutput += `<h3 id="v${chunkNum}">Verse ${chunkNum}</h3><p><em>No content.</em></p>\n`; return; }
            
            const sections = { verse: '', image: '', video: '', music_tags: '', negative_tags: '' }; 
            let current = 'verse';
            
            messageContent.split('\n').forEach(line => {
                if (/^[\*#]+\s*Image Prompt\s*[\*:]*$/i.test(line)) current = 'image';
                else if (/^[\*#]+\s*Video Prompt\s*[\*:]*$/i.test(line)) current = 'video';
                else if (/^\s*[\*#]+\s*.*(music|audio).*(prompt|tags)\s*[\*:]*$/i.test(line)) current = 'music_tags';
                else if (/^[\*#]+\s*Negative Music Tags\s*[\*:]*$/i.test(line)) current = 'negative_tags';
                else if (/^###\s*Verse\s*(\d*)\s*$/i.test(line)) current = 'verse';
                else if (sections[current] !== undefined) sections[current] += line + '\n';
            });
            
            Object.keys(sections).forEach(k => sections[k] = sections[k]?.trim() ?? '');
            
            const verse = sections.verse || messageContent;
            combinedVerseOutput += `<h3 id="v${chunkNum}">Verse ${chunkNum}</h3><div>${escapeHtml(verse).replace(/\n/g,'<br>')}</div>\n`;
            verseForLyrics += verse + "\n";
            
            if (sections.image) extractedImagePrompts.push(sections.image);
            if (sections.video) extractedVideoPrompts.push(sections.video);
            if (sections.music_tags) {
                console.log("Found music prompt from main text analysis.");
                extractedMusicTags.push(sections.music_tags);
            }
            if (sections.negative_tags) extractedNegativeMusicTags.push(sections.negative_tags);
        });

        // --- STEP 4: MEDIA GENERATION VIA COMFYUI ---
        console.log("\n--- Delegating to ComfyUI for Media Generation ---");

        let imageGenResult = { markdown: "<!-- No image prompt found -->", prompt: "" };
        if (extractedImagePrompts.length > 0) {
            const promptForImage = extractedImagePrompts[Math.floor(Math.random() * extractedImagePrompts.length)];
            imageGenResult = await generateImageWithComfyUI(promptForImage);
        }

        let videoGenResult = { markdown: "<!-- No video prompt found -->", positivePrompt: "", negativePrompt: "" };
        if (extractedVideoPrompts.length > 0) {
            const promptForVideo = extractedVideoPrompts[Math.floor(Math.random() * extractedVideoPrompts.length)];
            videoGenResult = await generateVideoWithComfyUI(promptForVideo, "blurry, low quality, watermark");
        }
        
        // --- MODIFIED: Lyric generation uses new helper functions ---
        let musicGenResult = { markdown: "<!-- No music tags or verse found -->", prompts: { tags: '', lyrics: '', negative_tags: ''} };
        if (extractedMusicTags.length > 0 && verseForLyrics.trim()) {
            const tagsForMusic = extractedMusicTags[Math.floor(Math.random() * extractedMusicTags.length)];
            const negativeTagsForMusic = extractedNegativeMusicTags.length > 0 ? extractedNegativeMusicTags[0] : 'low quality, bad audio, distorted';
            
            // Use the new functions to get a high-quality lyric snippet
            const lyricSnippet = extractLyricStanza(verseForLyrics);
            const cleanLyrics = cleanLyricsForMusicGen(lyricSnippet);

            if (cleanLyrics) {
                musicGenResult = await generateMusicWithComfyUI({
                    tags: tagsForMusic,
                    lyrics: cleanLyrics,
                    negative_tags: negativeTagsForMusic
                });
            } else {
                 console.warn("Could not extract a valid lyric stanza from the generated verse.");
            }
        }
        
        // --- STEP 5: ASSEMBLE FINAL MARKDOWN ---
        const youtubeAnalysisOutput = youtubeAnalysisResult ? 
            (youtubeAnalysisResult.success ? youtubeAnalysisResult.markdown : `\n### YouTube Audio Analysis\n<p><strong>Audio analysis failed:</strong> ${escapeHtml(youtubeAnalysisResult.error)}</p>\n`) :
            "<!-- Source was not a YouTube video -->";

        const promptHash = generatePromptHash(selectedPrompt.system + selectedPrompt.chat);
        const safeTitle = (inputData.ogResult.ogTitle || baseFilename).replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/\s+/g, '_').substring(0, 50);
        const modelNameClean = TEXT_MODEL_NAME.replace(/[^a-zA-Z0-9.-]/g, '');
        const outputFilename = `${safeTitle}-${modelNameClean}-${promptHash}.md`;
        const outputPath = path.join(OUTPUT_POSTS_DIR, outputFilename);
        const relJsonPath = `/${path.basename(JSON_COPY_DIR)}/${inputFile}`.replace(/\\/g, '/');
        
        const mdOutput = `---
title: "${escapeHtml(inputData.ogResult.ogTitle || 'Untitled')}-${modelNameClean}-${selectedPrompt.name}"
author: Gemini + ComfyUI
---
Source: [${inputData.ogResult.ogUrl || 'N/A'}](${inputData.ogResult.ogUrl || '#'})
${toc}<hr>${combinedVerseOutput}<hr>
### Sonnet for Original Image
${imageSonnetResult}<hr>

### Generated Image (via ComfyUI)
${imageGenResult.markdown}
<details><summary>Image Prompt</summary><pre><code>${escapeHtml(imageGenResult.prompt)}</code></pre></details><hr>

### Generated Video (via ComfyUI)
${videoGenResult.markdown}
<details><summary>Video Prompts</summary>
<strong>Positive:</strong><pre><code>${escapeHtml(videoGenResult.positivePrompt)}</code></pre>
<strong>Negative:</strong><pre><code>${escapeHtml(videoGenResult.negativePrompt)}</code></pre>
</details><hr>

### Generated Music (via ComfyUI)
${musicGenResult.markdown}
<details><summary>Music Generation Details</summary>
<strong>Tags:</strong><pre><code>${escapeHtml(musicGenResult.prompts?.tags)}</code></pre>
<strong>Negative Tags:</strong><pre><code>${escapeHtml(musicGenResult.prompts?.negative_tags)}</code></pre>
<strong>Lyrics Used:</strong><pre><code>${escapeHtml(musicGenResult.prompts?.lyrics)}</code></pre>
</details><hr>

### YouTube Audio Analysis
${youtubeAnalysisOutput}<hr>

<details><summary>Models & Prompt</summary>
<p><strong>Text Analysis:</strong> ${TEXT_MODEL_NAME}<br><strong>Vision Analysis:</strong> ${VISION_MODEL_NAME}</p>
<p><strong>Media Generation:</strong> Handled by local ComfyUI instance.</p>
<p><strong>Prompt (${selectedPrompt.name}):</strong></p>
<p><strong>Poet Style Used:</strong> ${escapeHtml(selectedPrompt.poet)}<br>
<strong>Verse Style Used:</strong> ${escapeHtml(selectedPrompt.style)}</p>
<strong>System:</strong><pre><code>${escapeHtml(selectedPrompt.system)}</code></pre><strong>Chat:</strong><pre><code>${escapeHtml(selectedPrompt.chat)}</code></pre></details><hr>
<button onclick="window.open('/js${relJsonPath}', '_blank');">Load Input JSON</button>`;

        await fs.writeFile(outputPath, mdOutput);
        console.log(`\nGenerated: ${outputPath}`);

    } catch (error) {
        console.error(`\n--- ERROR processing ${currentInputFile} ---`, error.stack || error);
    } finally { 
        currentInputFile = ''; 
        currentInputPath = ''; 
    }
}
// ... (escapeHtml, generatePromptHash, and main functions remain unchanged)
function escapeHtml(unsafe) { if (typeof unsafe !== 'string') return unsafe == null ? '' : String(unsafe); return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
function generatePromptHash(promptText, length = 8) { if (!promptText?.length) return 'noPrompt'; let hash = 0; for (let i = 0; i < promptText.length; i++) { hash = ((hash << 5) - hash) + promptText.charCodeAt(i); hash |= 0; } return Math.abs(hash).toString(16).padStart(length, '0').substring(0, length); }
async function main() { console.log("Starting Gemini script (ComfyUI Media Gen)..."); const localAudioIndex = process.argv.indexOf('--local-audio'); if (localAudioIndex > -1) { useLocalAudioProcessing = true; if (process.argv.length > localAudioIndex + 1 && !process.argv[localAudioIndex + 1].startsWith('--')) { localAudioStartTime = process.argv[localAudioIndex + 1]; } console.log(`>> Local YouTube audio processing is ENABLED. Starting at: ${localAudioStartTime}s.`); } else { console.log(">> Local YouTube audio processing is DISABLED. Use '--local-audio [time]' to enable."); } try { if (apiKey) { googleGenAIClient = new GoogleGenAI({ apiKey: apiKey }); console.log("GoogleGenAI Client initialized."); } else { console.error("GoogleGenAI Client NOT initialized: API_KEY missing."); } await fs.mkdir(OUTPUT_POSTS_DIR, { recursive: true }); await fs.mkdir(OUTPUT_IMAGES_DIR, { recursive: true }); await fs.mkdir(JSON_COPY_DIR, { recursive: true }); await loadAndPreparePrompts(); const promptIdx = getNextPromptIndexSync(); const selPrompt = availablePrompts[promptIdx]; console.log(`Selected prompt: ${selPrompt.name} (Index: ${promptIdx})`); setPromptIndexSync(promptIdx); const files = await fs.readdir(INPUT_DATA_DIR).catch(err => { if (err.code === 'ENOENT') { console.error(`Input dir ${INPUT_DATA_DIR} not found.`); process.exit(1); } throw err; }); const jsonFiles = files.filter(f => path.extname(f).toLowerCase() === '.json'); if (jsonFiles.length === 0) { console.log(`No JSON files in ${INPUT_DATA_DIR}.`); return; } console.log(`Found ${jsonFiles.length} JSON files.`); for (const file of jsonFiles) { await new Promise(resolve => setTimeout(resolve, 500)); await processSingleFile(file, selPrompt); } console.log("\n--- Script finished ---"); } catch (error) { console.error("\n--- FATAL ERROR ---", error.stack || error); process.exit(1); } }

main();
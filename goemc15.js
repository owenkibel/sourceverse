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
// Add this require statement at the top of your file
const yaml = require('js-yaml');
// --- SCRIPT CONFIGURATION (EDIT THESE VALUES) ---

// Snippet settings for the 'current.mp3' file created from YouTube audio
const SNIPPET_START_TIME_SECONDS = 30; // Start the snippet 30 seconds into the track
const SNIPPET_DURATION_SECONDS = 60; // Create a 60-second snippet

// Jamify creative settings
const JAMIFY_VAE_TYPE = "stable_audio"; // "stable_audio" for high fidelity, "diffrhythm" for default
const JAMIFY_USE_PROMPT_STYLE = false; // Let text prompt have more influence on style? (true/false)

// --- Model Configuration ---
const TEXT_MODEL_NAME = "gemini-flash-latest";
const VISION_MODEL_NAME = "gemini-flash-latest";
const INPUT_DATA_DIR = 'ogs_data';
const JSON_COPY_DIR = 'json';
const PROMPTS_DIR = path.join(__dirname, 'prompts');
const OUTPUT_POSTS_DIR = 'posts';
const OUTPUT_IMAGES_DIR = 'images';
const MAX_CHUNK_SIZE_CHARS = 1900000;

// --- JAMIFY & LYRICS CONFIGURATION ---
const JAMIFY_PROJECT_PATH = '/home/owen/cachyos2/owen/sourceverse/jamify';
const INPUT_AUDIO_DIR_JAMIFY = '/home/owen/cachyos2/owen/sourceverse/jamify/inputs';
const PYTHON_EXECUTABLE = '/home/owen/cachyos2/owen/sourceverse/jamify/venv_py310/bin/python';
const YT_DLP_COOKIES_PATH = path.join(__dirname, 'cookies.txt');
const WORD_DURATION_SECONDS = 0.5; // Default duration for each word in Jamify lyrics
const JAMIFY_CURRENT_INPUT_SONG = 'current.mp3';
const JAMIFY_DEFAULT_INPUT_SONG = 'singet.mp3';
// --- MEDIA GENERATION CONFIGURATION ---
const ACE_STEP_NEGATIVE_TAGS = "Mono, Harsh, Soft, Flat, Noisy, Indistinct, Muddy, Phasing, Flanging, Muffled, Dry, Ugly";

// --- Command Line Argument Handling ---
const useCurrentAudio = process.argv.includes('--current');

const apiKey = process.env.API_KEY;
if (!apiKey) {
    console.error("FATAL: API_KEY environment variable for Google AI is not set.");
    process.exit(1);
}
const genAI = new GoogleGenerativeAI(apiKey);
let textModel = genAI.getGenerativeModel({ model: TEXT_MODEL_NAME, generationConfig: { temperature: 1 } });
let visionModel = genAI.getGenerativeModel({ model: VISION_MODEL_NAME });

// --- UTILITY FUNCTIONS ---
async function loadPromptFile(filePath) { try { const fileContent = await fs.readFile(filePath, 'utf8'); return JSON.parse(fileContent); } catch (error) { console.error(`Error loading or parsing prompt from ${filePath}:`, error); throw new Error(`Failed to load/parse prompt file: ${filePath}.`); } }
async function loadAndPreparePrompts() { let availablePrompts = []; try { const promptFiles = await fs.readdir(PROMPTS_DIR); for (const file of promptFiles) { if (path.extname(file).toLowerCase() !== '.json') continue; const filePath = path.join(PROMPTS_DIR, file); const promptData = await loadPromptFile(filePath); if (!promptData.system || !promptData.chat) continue; let systemPrompt = promptData.system; let chatPrompt = promptData.chat; const style = promptData.style?.[Math.floor(Math.random() * promptData.style.length)] || ""; const poet = promptData.poet?.[Math.floor(Math.random() * promptData.poet.length)] || ""; systemPrompt = systemPrompt.replace(/\[\[verseStyle]]/g, style).replace(/\[\[poet]]/g, poet); chatPrompt = chatPrompt.replace(/\[\[poet]]/g, poet); if (!chatPrompt.includes('[[chunk]]')) chatPrompt += "\n\nAnalyze the following text:\n[[chunk]]"; availablePrompts.push({ name: path.basename(file, '.json'), system: systemPrompt, chat: chatPrompt, style, poet }); } if (availablePrompts.length === 0) throw new Error(`No valid prompt files found in ${PROMPTS_DIR}.`); console.log(`Successfully loaded ${availablePrompts.length} prompts.`); return availablePrompts; } catch (error) { console.error("Error loading prompts:", error); throw error; } }
function unescapeHtml(text) { if (typeof text !== 'string') return text == null ? '' : String(text); return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&nbsp;/g, ' '); }
function escapeHtml(unsafe) { if (typeof unsafe !== 'string') return unsafe == null ? '' : String(unsafe); return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
function extractLyricStanza(fullVerse) { 
    if (!fullVerse || typeof fullVerse !== 'string') return ''; 
    const stanzas = fullVerse.trim().split(/\n\s*\n/); 
    const potentialStanzas = stanzas.filter(s => s.trim().split('\n').length > 1); 
    if (potentialStanzas.length === 0) return stanzas.find(s => s.trim()) || ''; 
    let selectedLyrics = ''; 
    let lineCount = 0; 
    for (const stanza of potentialStanzas) { 
        const linesInStanza = stanza.trim().split('\n'); 
        selectedLyrics += (selectedLyrics ? '\n\n' : '') + linesInStanza.join('\n'); 
        lineCount += linesInStanza.length; 
        if (lineCount >= 8) break; 
    } 
    return selectedLyrics; 
}
function cleanLyricsForMusicGen(text) { if (typeof text !== 'string') return ''; return unescapeHtml(text).replace(/<[^>]+>/g, '').replace(/[\*_`#\[\]\(\)]/g, '').split('\n').map(line => line.trim()).join('\n').trim(); }
function generateTimedLyricsFromJson(stanza) {
    if (!stanza) return null;
    const lines = stanza.split('\n');
    const timedLyrics = [];
    const LYRICS_START_SECOND = 15.0;
    let currentTime = LYRICS_START_SECOND + 0.5;

    for (const line of lines) {
        const words = line.trim().split(/\s+/).filter(w => w);
        if (words.length === 0) continue;

        for (const word of words) {
            const cleanedWord = word.replace(/[^\p{L}\p{N}\p{P}\s'-]/gu, '');
            if (!cleanedWord) continue;

            timedLyrics.push({
                start: parseFloat(currentTime.toFixed(2)),
                end: parseFloat((currentTime + WORD_DURATION_SECONDS).toFixed(2)),
                word: cleanedWord
            });
            currentTime += WORD_DURATION_SECONDS;
        }
        currentTime += WORD_DURATION_SECONDS * 0.5;
    }
    let totalDuration = parseFloat(currentTime.toFixed(2));
    return { timedLyrics, totalDuration };
}
async function processOriginalImage(imageUrl) { if (!imageUrl) return ""; try { let mimeType = "image/jpeg"; const ext = path.extname(new URL(imageUrl).pathname).toLowerCase(); if (ext === '.png') mimeType = "image/png"; else if (ext === '.webp') mimeType = "image/webp"; const res = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 20000 }); const imagePart = { inlineData: { data: Buffer.from(res.data, 'binary').toString("base64"), mimeType } }; const result = await visionModel.generateContent(["Compose a Shakespearean Sonnet for this image.", imagePart]); const sonnet = result.response?.text?.(); if (!sonnet) return `<!-- Vision skip: No content. -->\n`; return `### Sonnet for Original Image\n\n![](${encodeURI(imageUrl)})\n\n${sonnet.trim()}\n\n`; } catch (error) { console.error(`Vision error (${imageUrl}):`, error.message); return "<!-- Vision processing failed -->\n"; } }

// --- YOUTUBE ANALYSIS FUNCTIONS ---
const YOUTUBE_ANALYSIS_PROMPT_UNIFIED = `You will be provided with context from a video. Your task is to perform a multi-part analysis.\n\n### Part 1: Synopsis & Transcript\nCreate an accurate and comprehensive transcript of all spoken content. Also, provide a concise synopsis of the video's message and imagery.\n\n### Part 2: Detailed Audio Analysis\nProvide a detailed analysis of non-speech audio: soundscape, music (genre, mood, instrumentation), and voice quality.\n\n### Music Tags:\n**This is a critical part.** Based on the audio, create a single line of comma-delimited descriptive tags for a music generation model. If no music is present, imagine a fitting soundtrack. Example: baroque, opera, oratorio, aria, acoustic ensemble, folk, inspirational, powerful, original, interesting.`;
async function performYouTubeAnalysis(audioPart, youtubeUrl) { console.log(`Requesting YouTube analysis for ${youtubeUrl}...`); try { const result = await textModel.generateContent([YOUTUBE_ANALYSIS_PROMPT_UNIFIED, audioPart]); const analysisText = result.response.text(); const markdown = `\n<details><summary>YouTube Audio Analysis</summary><pre><code>${escapeHtml(analysisText)}</code></pre></details>\n`; return { success: true, markdown: markdown, rawText: analysisText }; } catch (error) { console.error(`Error during YouTube analysis for ${youtubeUrl}:`, error); return { success: false, error: error.message }; } }

async function analyzeYouTubeAudioLocally(youtubeUrl) {
    console.log(`Performing local audio analysis for: ${youtubeUrl}.`);
    const tempFileName = `temp-audio-${Date.now()}.opus`;
    const tempFilePath = path.join(os.tmpdir(), tempFileName);
    // --- Inside analyzeYouTubeAudioLocally function ---

    try {
        const args = [
            '--no-playlist', // Ensure only the single video is downloaded, not the whole album/list
            '-f', 'bestaudio/best',
            '-x', '--audio-format', 'opus',
            '-o', tempFilePath,
            youtubeUrl
        ];
        if (fss.existsSync(YT_DLP_COOKIES_PATH)) {
//...
            console.log("Found cookies.txt, using it for yt-dlp download.");
            args.unshift('--cookies', YT_DLP_COOKIES_PATH);
        } else {
            console.log("No cookies.txt found, attempting download without them.");
        }
        await execFileAsync('yt-dlp', args);

       // Side-effect: Create a configured MP3 snippet for Jamify
        const snippetPath = path.join(INPUT_AUDIO_DIR_JAMIFY, JAMIFY_CURRENT_INPUT_SONG);
        try {
            await new Promise((resolve, reject) => {
                ffmpeg(tempFilePath)
                    .setStartTime(SNIPPET_START_TIME_SECONDS)
                    .setDuration(SNIPPET_DURATION_SECONDS)
                    .audioCodec('libmp3lame')
                    .audioBitrate('192k')
                    .toFormat('mp3')
                    .on('end', resolve)
                    .on('error', (err) => reject(new Error(`FFmpeg snippet creation failed: ${err.message}`)))
                    .save(snippetPath);
            });
            console.log(`Successfully created ${SNIPPET_DURATION_SECONDS}-second snippet: ${snippetPath}`);
        } catch (ffmpegError) {
            console.error(ffmpegError);
        }

        // Continue with main task: preparing audio for Gemini analysis
        const audioFileBuffer = await fs.readFile(tempFilePath);
        const audioPart = { inlineData: { data: audioFileBuffer.toString("base64"), mimeType: "audio/opus" } };
        return await performYouTubeAnalysis(audioPart, youtubeUrl);

    } catch (error) {
        console.error(`Local YouTube audio analysis failed for ${youtubeUrl}:`, error);
        if (error.message.includes('HTTP Error 403')) {
            console.error("\n>>> HINT: A 403 Forbidden error often means YouTube is blocking requests. Ensure your 'cookies.txt' file is present and up-to-date.\n");
        }
        return { success: false, error: error.message };
    } finally {
        try { await fs.unlink(tempFilePath); } catch (e) { /* ignore */ }
    }
}
async function analyzeYouTubeAudio(youtubeUrl) { return await analyzeYouTubeAudioLocally(youtubeUrl); }

// --- SCRIPT ORCHESTRATION & MEDIA GENERATION ---
async function executeComfyScript(scriptName, promptData) { const stateFileName = `temp-state-${path.basename(scriptName, '.js')}-${Date.now()}.json`; const stateFilePath = path.join(os.tmpdir(), stateFileName); const scriptPath = path.join(__dirname, scriptName); const args = [scriptPath, '--state-file', stateFilePath]; try { for (const [fileName, content] of Object.entries(promptData)) { await fs.writeFile(fileName, content || '', 'utf8'); } const { stdout, stderr } = await execFileAsync('node', args); if (stderr) console.warn(`[${scriptName}] Stderr:\n`, stderr); const state = JSON.parse(await fs.readFile(stateFilePath, 'utf8')); return { success: true, path: state.savedFilePath, filename: state.filename }; } catch (error) { console.error(`\n--- ERROR executing ${scriptName} ---`, error); return { success: false, error: error.message }; } finally { try { await fs.unlink(stateFilePath); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') console.error(`Failed to clean up state file:`, cleanupError); } } }

async function executeJamifyScript({ tags, timedLyricsJson, duration, jamifyConfig }) {
    if (!tags || !timedLyricsJson || !duration) {
        return { success: false, markdown: "<!-- Jamify skipped: Missing tags, timed lyrics, or duration. -->", prompts: { tags, timedLyricsJson, duration } };
    }

    const baseConfigPath = path.join(JAMIFY_PROJECT_PATH, 'configs', 'jam_infer.yaml');
    const tempConfigPath = path.join(os.tmpdir(), `temp-jam-config-${Date.now()}.yaml`);
    let useCpu = false;

    const runJamify = async () => {
        try {
            // --- 1. Create Dynamic Config ---
            const baseConfig = yaml.load(await fs.readFile(baseConfigPath, 'utf8'));
            const finalConfig = { ...baseConfig, ...jamifyConfig }; // Merge our custom settings
            await fs.writeFile(tempConfigPath, yaml.dump(finalConfig), 'utf8');
            console.log('Generated temporary Jamify config with custom settings.');

            let selectedAudioFile;
            const currentAudioPath = path.join(INPUT_AUDIO_DIR_JAMIFY, JAMIFY_CURRENT_INPUT_SONG);

            if (useCurrentAudio && fss.existsSync(currentAudioPath)) {
                selectedAudioFile = JAMIFY_CURRENT_INPUT_SONG;
                console.log(`Using --current flag. Selected Jamify input audio: ${selectedAudioFile}`);
            } else {
                selectedAudioFile = JAMIFY_DEFAULT_INPUT_SONG;
                if (useCurrentAudio) {
                    console.warn(`Warning: --current flag was used, but ${currentAudioPath} was not found. Defaulting to ${selectedAudioFile}.`);
                } else {
                    console.log(`Defaulting to Jamify input audio: ${selectedAudioFile}`);
                }
            }

            const inputsDir = path.join(JAMIFY_PROJECT_PATH, 'inputs');
            await fs.mkdir(inputsDir, { recursive: true });
            const jamifyPromptPath = path.join(inputsDir, 'prompt.txt');
            const jamifyLyricsPath = path.join(inputsDir, 'timed_lyrics.json');
            await fs.writeFile(jamifyPromptPath, tags, 'utf8');
            await fs.writeFile(jamifyLyricsPath, JSON.stringify(timedLyricsJson, null, 2), 'utf8');

            const id = `jamify-output-${Date.now()}`;
            const inputJsonPath = path.join(JAMIFY_PROJECT_PATH, 'inputs', 'input.json');
            const inputData = [{ "id": id, "audio_path": `inputs/${selectedAudioFile}`, "lrc_path": "inputs/timed_lyrics.json", "duration": duration, "prompt_path": "inputs/prompt.txt" }];
            await fs.writeFile(inputJsonPath, JSON.stringify(inputData, null, 2), 'utf8');

            const activatePath = path.join(JAMIFY_PROJECT_PATH, 'venv_py310/bin/activate');
            
            // --- 2. Update Command to Use New Config ---
            const inferenceCommand = `accelerate launch --mixed_precision=fp16 inference.py --config_path "${tempConfigPath}"`;
            let innerCommand = `python -c "import torch; torch.cuda.empty_cache()" && ${inferenceCommand}`;
            if (useCpu) {
                innerCommand = `accelerate launch --mixed_precision=fp16 --cpu inference.py --config_path "${tempConfigPath}"`;
            }
            const command = `bash -c 'source "${activatePath}" && export PYTHONPATH="${JAMIFY_PROJECT_PATH}/src:\$PYTHONPATH" && export PYTORCH_ALLOC_CONF=expandable_segments:True && cd ${JAMIFY_PROJECT_PATH} && ${innerCommand}'`;
            
            console.log(`Executing Jamify with command: ${command}`);
            
            const { stdout, stderr } = await execAsync(command, { cwd: __dirname });

            if (stderr) console.warn(`[Jamify Stderr]:\n`, stderr);
            console.log(`[Jamify Stdout]:\n`, stdout);

            const generatedDir = path.join(JAMIFY_PROJECT_PATH, 'outputs', 'generated');
            const outputFiles = await fs.readdir(generatedDir);
            // --- 3. Prioritize WAV file for best quality ---
            let generatedFile = outputFiles.find(f => f.startsWith(id) && f.toLowerCase().endsWith('.wav'));
            if (!generatedFile) {
                 generatedFile = outputFiles.find(f => f.startsWith(id)); // Fallback to any file
            }

            if (!generatedFile) {
                throw new Error(`Jamify script finished but no output file starting with '${id}' was found in '${generatedDir}'. Stderr: ${stderr}`);
            }

            const generatedFilePath = path.join(generatedDir, generatedFile);
            const outputExt = '.opus';
            const finalOutputFilename = `${id}${outputExt}`;
            const absoluteFinalPath = path.join(__dirname, OUTPUT_IMAGES_DIR, finalOutputFilename);

            console.log(`Jamify created ${generatedFile}. Converting to .opus...`);

            await new Promise((resolve, reject) => {
                ffmpeg(generatedFilePath)
                    .audioCodec('libopus')
                    .audioBitrate('128k')
                    .toFormat('opus')
                    .on('end', () => { fs.unlink(generatedFilePath).catch(() => {}); resolve(); })
                    .on('error', (err) => { reject(new Error(`FFmpeg conversion failed: ${err.message}`)); })
                    .save(absoluteFinalPath);
            });
            
            console.log(`✅ Jamify ${outputExt} ready. Output: ${finalOutputFilename}`);
            return { success: true, markdown: `\n<audio controls src="/images/${finalOutputFilename}"></audio>\n`, prompts: { tags, timedLyricsJson, duration } };

        } catch (error) {
            console.error(`\n--- ERROR executing Jamify script ---`, error);
            if (!useCpu && (error.message.includes('OutOfMemoryError') || (typeof error.stderr === 'string' && error.stderr.includes('OutOfMemoryError')))) {
                console.log('Detected OOM error. Retrying on CPU...');
                useCpu = true;
                return await runJamify();
            }
            return { success: false, markdown: `<p><strong>Jamify failed.</strong> Error: ${escapeHtml(error.message)}</p>`, prompts: { tags, timedLyricsJson, duration } };
        } finally {
            try { await fs.unlink(tempConfigPath); } catch (e) { /* ignore */ } // --- 4. Cleanup ---
        }
    };

    return await runJamify();
}


async function generateImageWithComfyUI(prompt) { if (!prompt?.trim()) return { success: false, markdown: "<!-- No prompt -->", prompt: "" }; const result = await executeComfyScript('run_flux_modified.js', { 'prompt.txt': prompt }); if (result.success) return { success: true, markdown: `\n\n![Generated Image](/images/${result.filename})\n\n`, prompt }; return { success: false, markdown: `\n\n<!-- Gen Failed: ${escapeHtml(result.error)} -->\n\n`, prompt }; }
async function generateVideoWithComfyUI(positivePrompt, negativePrompt = "blurry") { if (!positivePrompt?.trim()) return { success: false, markdown: "<!-- No prompt -->", positivePrompt: "", negativePrompt }; const result = await executeComfyScript('t2v_modified.js', { 'prompt.txt': positivePrompt, 'negative_prompt.txt': negativePrompt }); if (result.success) return { success: true, markdown: `\n\n<video controls width="100%"><source src="/images/${result.filename}" type="video/webm"></video>\n\n`, positivePrompt, negativePrompt }; return { success: false, markdown: `\n\n<!-- Gen Failed: ${escapeHtml(result.error)} -->\n\n`, positivePrompt, negativePrompt }; }
async function generateMusicWithComfyUI(prompts) { const { tags, lyrics, negative_tags } = prompts; if (!tags?.trim() || !lyrics?.trim()) return { success: false, markdown: "<!-- No prompts -->", prompts: {tags, lyrics, negative_tags} }; const result = await executeComfyScript('run_ace_step1_modified.js', { 'tags.txt': tags, 'lyrics.txt': lyrics, 'negative_tags.txt': negative_tags || '' }); if (result.success) return { success: true, markdown: `\n<audio controls src="/images/${result.filename}"></audio>\n`, prompts }; return { success: false, markdown: `\n<p><strong>Gen Failed.</strong> Error: ${escapeHtml(result.error)}</p>`, prompts }; }


async function processSingleFile(inputFile, selectedPrompt) {
    let currentInputFile = inputFile;
    const baseFilename = path.basename(inputFile, '.json');
    console.log(`\n--- Processing: ${inputFile} with Prompt: ${selectedPrompt.name} ---`);
    try {
        const currentInputPath = path.join(INPUT_DATA_DIR, inputFile);
        let inputData = JSON.parse(await fs.readFile(currentInputPath, 'utf8'));
        inputData.ogResult = inputData.ogResult || {};
        inputData.ogResult.ogTitle = inputData.ogResult.ogTitle || 'Untitled';
        await fs.writeFile(path.join(JSON_COPY_DIR, inputFile), JSON.stringify(inputData, null, 2));
        
        const originalImageUrl = inputData.ogResult.ogImage?.[0]?.url;
        let fullTextContent = [inputData.ogResult?.ogUrl, inputData.ogResult?.ogTitle, inputData.ogResult?.ogDescription].filter(Boolean).join('\n');
        const cleanedHtml = (inputData.ogHTML || '').replace(/<style[^>]*>.*?<\/style>|<script[^>]*>.*?<\/script>|<[^>]+>/gis, ' ').replace(/\s{2,}/g, ' ').trim();
        if (cleanedHtml) fullTextContent += `\n\nPage Content:\n${cleanedHtml}`;
        fullTextContent = fullTextContent.trim();
        if (!fullTextContent) { console.warn(`Skipping ${inputFile}: No text content.`); return; }

        const youtubeAnalysisPromise = inputData.ogResult.ogUrl && /youtube\.com|youtu\.be/i.test(inputData.ogResult.ogUrl)
            ? analyzeYouTubeAudio(inputData.ogResult.ogUrl.replace('music.youtube.com', 'youtube.com'))
            : Promise.resolve(null);

        const textChunks = [];
        for (let i = 0; i < fullTextContent.length; i += MAX_CHUNK_SIZE_CHARS) textChunks.push(fullTextContent.substring(i, i + MAX_CHUNK_SIZE_CHARS));
        
        const textApiPromises = textChunks.map((chunk) => {
            const userPrompt = selectedPrompt.chat.replace('[[chunk]]', chunk);
            const fullApiPrompt = `${selectedPrompt.system}\n\n${userPrompt}`;
            return textModel.generateContent({ contents: [{ role: "user", parts: [{ text: fullApiPrompt }] }], generationConfig: { maxOutputTokens: 8192 } }).catch(err => ({ error: true, message: err.message }));
        });

        const [imageSonnetResult, youtubeAnalysisResult, ...textApiResults] = await Promise.all([processOriginalImage(originalImageUrl), youtubeAnalysisPromise, ...textApiPromises]);

        let combinedVerseOutput = "", toc = "## Table of Contents\n";
        const allPrompts = { image: [], video: [], music_tags: [], negative_tags: [] };
        let verseForLyrics = "";

        // ... inside processSingleFile ...
        if (youtubeAnalysisResult && youtubeAnalysisResult.success && youtubeAnalysisResult.rawText) {
            // This new regex flexibly handles prefixes, makes the colon optional, and accepts newlines after the header.
            const match = youtubeAnalysisResult.rawText.match(/(?:#+\s*|Part \d+:\s*)?Music Tags:?\s*([\s\S]*?)(?=###|$)/i);
            if (match && match[1]) {
// ...
                console.log("Found music tags in YouTube analysis result.");
                allPrompts.music_tags.push(match[1].trim().replace(/\n/g, ' '));
            }
        }

        textApiResults.forEach((result, index) => {
            toc += `- [Verse ${index + 1}](#v${index + 1})\n`;
            if (result.error) { combinedVerseOutput += `<h3 id="v${index + 1}">Verse ${index + 1}</h3><p><em>Error: ${result.message}</em></p>\n`; return; }
            const messageContent = result.response?.text?.()?.trim();
            if (!messageContent) { combinedVerseOutput += `<h3 id="v${index + 1}">Verse ${index + 1}</h3><p><em>No content.</em></p>\n`; return; }
            
            const sections = { verse: '', image: '', video: '', music_prompts: '' };
            let current = 'verse';
            messageContent.split('\n').forEach(line => {
                if (/^[\*#]+\s*Image Prompt\s*[\*:]*$/i.test(line)) current = 'image';
                else if (/^[\*#]+\s*Video Prompt\s*[\*:]*$/i.test(line)) current = 'video';
                else if (/^[\*#]+\s*Music & Audio Prompts\s*[\*:]*$/i.test(line)) current = 'music_prompts';
                else if (/^###\s*Verse\s*(\d*)\s*$/i.test(line)) current = 'verse';
                else if (sections[current] !== undefined) sections[current] += line + '\n';
            });

            const verse = sections.verse || messageContent;
            combinedVerseOutput += `<h3 id="v${index + 1}">Verse ${index + 1}</h3><div>${escapeHtml(verse).replace(/\n/g,'<br>')}</div>\n`;
            verseForLyrics += verse + "\n\n";

            if (sections.image) allPrompts.image.push(sections.image.trim());
            if (sections.video) allPrompts.video.push(sections.video.trim());
            
            if (sections.music_prompts) {
                const tagsMatch = sections.music_prompts.match(/tags:([\s\S]*?)(negative tags:|$)/i);
                const negativeMatch = sections.music_prompts.match(/negative tags:([\s\S]*)/i);

                if(tagsMatch && tagsMatch[1]) {
                    console.log("Found 'Tags' in main generation output.");
                    allPrompts.music_tags.push(tagsMatch[1].trim().replace(/\n/g, ' '));
                }
                if(negativeMatch && negativeMatch[1]) {
                    console.log("Found 'Negative Tags' in main generation output.");
                    allPrompts.negative_tags.push(negativeMatch[1].trim().replace(/\n/g, ' '));
                }
            }
        });

        if (allPrompts.music_tags.length === 0) {
            console.warn("Music tags not found in any model output. Using a generic fallback.");
            allPrompts.music_tags.push("baroque, opera, oratorio, aria, acoustic ensemble, folk, inspirational, uplifting, powerful, instrumental");
        }

        console.log("\n--- Delegating to ComfyUI & Jamify for Media Generation ---");
    
   // Build the Jamify configuration from the constants at the top of the script
    const jamifyConfig = {
        evaluation: {
            vae_type: JAMIFY_VAE_TYPE,
            num_style_secs: SNIPPET_DURATION_SECONDS,
            use_prompt_style: JAMIFY_USE_PROMPT_STYLE,
        }
    };
    
    const lyricSnippet = extractLyricStanza(verseForLyrics);
    const cleanLyricsForAceStep = cleanLyricsForMusicGen(lyricSnippet);
    const timedLyricsResult = generateTimedLyricsFromJson(lyricSnippet);
    
    let timedLyricsForJamify = null;
    let jamifyDuration = 0;
    if (timedLyricsResult) {
        timedLyricsForJamify = timedLyricsResult.timedLyrics;
        jamifyDuration = timedLyricsResult.totalDuration + 15.0;
    }

    const imageGenResult = await generateImageWithComfyUI(allPrompts.image[0]);
    const videoGenResult = await generateVideoWithComfyUI(allPrompts.video[0]);
    const musicGenResult = await generateMusicWithComfyUI({
        tags: allPrompts.music_tags[0],
        lyrics: cleanLyricsForAceStep,
        negative_tags: ACE_STEP_NEGATIVE_TAGS
    });

    console.log("Waiting 60 seconds to allow manual ComfyUI server termination...");
    const jamifyMusicResult = await new Promise((resolve) => {
        setTimeout(async () => {
            const result = await executeJamifyScript({
                tags: allPrompts.music_tags[0],
                timedLyricsJson: timedLyricsForJamify,
                duration: jamifyDuration,
                jamifyConfig: jamifyConfig // Pass the config object here
            });
            resolve(result);
        }, 60000);
    });
        
        const safeTitle = (inputData.ogResult.ogTitle || baseFilename).replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/\s+/g, '_').substring(0, 50);
        const outputFilename = `${safeTitle}-${Date.now()}.md`;
        const outputPath = path.join(OUTPUT_POSTS_DIR, outputFilename);
        const timedLyricsJsonString = timedLyricsForJamify ? JSON.stringify(timedLyricsForJamify, null, 2) : '// Lyrics stanza could not be processed.';
        const youtubeAnalysisOutput = youtubeAnalysisResult?.success ? youtubeAnalysisResult.markdown : "<!-- No YouTube analysis performed or it failed. -->";

        const mdOutput = `---
title: "${escapeHtml(inputData.ogResult.ogTitle)}"
author: Gemini + ComfyUI + Jamify
---
Source: [${inputData.ogResult.ogUrl || 'N/A'}](${inputData.ogResult.ogUrl || '#'})
${toc}<hr>${combinedVerseOutput}<hr>
### Sonnet for Original Image
${imageSonnetResult}<hr>
### Generated Image (ComfyUI)
${imageGenResult.markdown}
<details><summary>Image Prompt</summary><pre><code>${escapeHtml(imageGenResult.prompt)}</code></pre></details><hr>
### Generated Video (ComfyUI)
${videoGenResult.markdown}
<details><summary>Video Prompts</summary><strong>Positive:</strong><pre><code>${escapeHtml(videoGenResult.positivePrompt)}</code></pre></details><hr>
### Generated Music (Ace-Step)
${musicGenResult.markdown}
<details><summary>Ace-Step Details</summary><strong>Tags:</strong><pre><code>${escapeHtml(musicGenResult.prompts?.tags)}</code></pre><strong>Lyrics Used:</strong><pre><code>${escapeHtml(musicGenResult.prompts?.lyrics)}</code></pre></details><hr>
### Generated Music (Jamify)
${jamifyMusicResult.markdown}
<details><summary>Jamify Details</summary><strong>Prompt:</strong><pre><code>${escapeHtml(jamifyMusicResult.prompts?.tags)}</code></pre><strong>JSON Payload:</strong><pre><code class="language-json">${escapeHtml(JSON.stringify(jamifyMusicResult.prompts?.timedLyricsJson, null, 2))}</code></pre><strong>Duration:</strong><pre><code>${jamifyMusicResult.prompts?.duration}s</code></pre></details>
### YouTube Audio Analysis
${youtubeAnalysisOutput}<hr>
<details><summary>Models & Prompt</summary><p><strong>Text/Vision:</strong> ${TEXT_MODEL_NAME}</p><p><strong>Prompt (${selectedPrompt.name}):</strong></p><pre><code>${escapeHtml(selectedPrompt.system)}</code></pre><pre><code>${escapeHtml(selectedPrompt.chat)}</code></pre></details>`;
        
        await fs.writeFile(outputPath, mdOutput);
        console.log(`\nGenerated: ${outputPath}`);
    } catch (error) {
        console.error(`\n--- ERROR processing ${currentInputFile} ---`, error.stack || error);
    }
}

async function main() {
    console.log("Starting Orchestration Script...");
    if (!fss.existsSync(JAMIFY_PROJECT_PATH)) console.warn(`Warning: JAMIFY_PROJECT_PATH not found at '${JAMIFY_PROJECT_PATH}'.`);
    if (!fss.existsSync(INPUT_AUDIO_DIR_JAMIFY)) console.warn(`Warning: INPUT_AUDIO_DIR_JAMIFY not found at '${INPUT_AUDIO_DIR_JAMIFY}'.`);
    
    await fs.mkdir(OUTPUT_POSTS_DIR, { recursive: true });
    await fs.mkdir(OUTPUT_IMAGES_DIR, { recursive: true });
    await fs.mkdir(JSON_COPY_DIR, { recursive: true });
    
    const availablePrompts = await loadAndPreparePrompts();
    const promptIdx = Math.floor(Math.random() * availablePrompts.length);
    const selPrompt = availablePrompts[promptIdx];
    console.log(`Selected prompt: ${selPrompt.name}`);

    const files = await fs.readdir(INPUT_DATA_DIR).catch(() => {
        console.error(`Input dir ${INPUT_DATA_DIR} not found.`);
        process.exit(1);
    });
    
    const jsonFiles = files.filter(f => path.extname(f).toLowerCase() === '.json');
    if (jsonFiles.length === 0) {
        console.log(`No JSON files in ${INPUT_DATA_DIR}.`);
        return;
    }
    
    console.log(`Found ${jsonFiles.length} JSON files.`);
    for (const file of jsonFiles) {
        await processSingleFile(file, selPrompt);
    }
    
    console.log("\n--- Script finished ---");
}

main();
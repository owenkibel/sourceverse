const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');

// Grok-specific require (using OpenAI client)
const OpenAI = require("openai");

// Gemini-specific requires
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const { GoogleGenAI } = require('@google/genai');

const axios = require('axios');
const { createWriteStream } = require("fs");
const { Readable } = require("stream");

// --- Model Configuration ---
const TEXT_MODEL_NAME = "grok-3-mini";
const GEMINI_VISION_MODEL_NAME = "gemini-2.5-flash-lite";
const GEMINI_IMAGE_GEN_MODEL_NAME = "imagen-4.0-fast-generate-001";
const VEO_MODEL_NAME = "veo-3.0-generate-preview";

// --- Constants ---
const INPUT_DATA_DIR = 'ogs_data';
const JSON_COPY_DIR = 'json';
const PROMPTS_DIR = path.join(__dirname, 'prompts');
const OUTPUT_POSTS_DIR = 'posts';
const OUTPUT_IMAGES_DIR = 'images';
const PROMPT_STATE_FILE = path.join(__dirname, 'grok.txt');
const MAX_CHUNK_TOKEN_ESTIMATE = 500000;
const AVG_CHARS_PER_TOKEN = 4;
const MAX_CHUNK_SIZE_CHARS = MAX_CHUNK_TOKEN_ESTIMATE * AVG_CHARS_PER_TOKEN;

// --- API Client Initialization ---

// GROK API Client
const grokApiKey = process.env.XAI_API_KEY;
if (!grokApiKey) {
    console.error("FATAL: XAI_API_KEY environment variable for Grok is not set.");
    process.exit(1);
}
const grokClient = new OpenAI({
    apiKey: grokApiKey,
    baseURL: "https://api.x.ai/v1",
});
console.log(`Grok Client initialized for Text Generation.`);

// GEMINI API Client
const geminiApiKey = process.env.API_KEY;
if (!geminiApiKey) {
    console.error("FATAL: API_KEY environment variable for Google AI is not set.");
    process.exit(1);
}
const genAI = new GoogleGenerativeAI(geminiApiKey);
let googleGenAIClient; // For Image/Video Gen via @google/genai
let geminiVisionModel; // For Vision via @google/generative-ai

const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

try {
    googleGenAIClient = new GoogleGenAI({ apiKey: geminiApiKey });
    geminiVisionModel = genAI.getGenerativeModel({ model: GEMINI_VISION_MODEL_NAME, safetySettings });
    console.log("Google/Gemini Clients initialized for Vision, Image & Video Gen.");
} catch (e) {
    console.error("FATAL: Could not initialize Google/Gemini Clients.", e.message);
    process.exit(1);
}

console.log(`--- Model Pipeline ---`);
console.log(`- Text & Prompt Generation -> ${TEXT_MODEL_NAME}`);
console.log(`- Vision Analysis -> ${GEMINI_VISION_MODEL_NAME}`);
console.log(`- Image Generation -> ${GEMINI_IMAGE_GEN_MODEL_NAME}`);
console.log(`- Video Generation -> Gemini ${VEO_MODEL_NAME}`);

let currentInputFile = '';
let currentInputPath = '';
let availablePrompts = [];

// --- Helper and Utility Functions ---

async function loadPromptFile(filePath) {
    try {
        const fileContent = await fs.readFile(filePath, 'utf8');
        return JSON.parse(fileContent);
    } catch (error) {
        throw new Error(`Failed to load/parse prompt file: ${filePath}.`);
    }
}

async function loadAndPreparePrompts() {
    availablePrompts = [];
    try {
        const promptFiles = await fs.readdir(PROMPTS_DIR);
        for (const file of promptFiles) {
            if (path.extname(file).toLowerCase() !== '.json') continue;
            const filePath = path.join(PROMPTS_DIR, file);
            const promptData = await loadPromptFile(filePath);
            if (!promptData.system || !promptData.chat) continue;
            let systemPrompt = promptData.system, chatPrompt = promptData.chat;
            const style = promptData.style?.[Math.floor(Math.random() * promptData.style.length)] || "";
            const poet = promptData.poet?.[Math.floor(Math.random() * promptData.poet.length)] || "";
            systemPrompt = systemPrompt.replace(/\[\[verseStyle]]/g, style).replace(/\[\[poet]]/g, poet);
            chatPrompt = chatPrompt.replace(/\[\[poet]]/g, poet);
            if (!chatPrompt.includes('[[chunk]]')) chatPrompt += "\n\nAnalyze the following text:\n[[chunk]]";
            availablePrompts.push({ name: path.basename(file, '.json'), system: systemPrompt, chat: chatPrompt, style, poet });
        }
        if (availablePrompts.length === 0) throw new Error(`No valid prompt files found.`);
        console.log(`Successfully loaded ${availablePrompts.length} prompts.`);
    } catch (error) {
        console.error("Error loading prompts:", error);
        throw error;
    }
}

function getNextPromptIndexSync() {
    try {
        if (availablePrompts.length === 0) return 0;
        const data = fss.readFileSync(PROMPT_STATE_FILE, 'utf-8');
        const index = parseInt(data.trim(), 10);
        return (isNaN(index) || index < 0) ? 0 : (index + 1) % availablePrompts.length;
    } catch { return 0; }
}

function setPromptIndexSync(index) {
    try { fss.writeFileSync(PROMPT_STATE_FILE, String(index), 'utf-8'); }
    catch (error) { console.error(`Error writing prompt state file:`, error); }
}

function transformInputJson(input) {
    const newObject = {
        name: input.title || 'Untitled', url: input.source || '',
        ogResult: { ogTitle: input.title || 'Untitled', ogDescription: input.description || '', ogUrl: input.source || '', ogImage: [] },
        ogHTML: input.content || '', ogLength: (input.content || '').length, youtube: input.youtube,
    };
    if (input.images?.length > 0) {
        const getImageSizeRank = (url) => {
            try {
                const name = new URLSearchParams(new URL(url).search).get('name');
                if (name) {
                    if (name.toLowerCase() === 'orig') return 10000; if (name.toLowerCase() === 'large') return 5000;
                    const dimMatch = name.match(/^(\d+)x(\d+)$/); if (dimMatch) return parseInt(dimMatch[1]) * parseInt(dimMatch[2]);
                }
            } catch {}
            if (url.includes('_bigger.')) return 75; if (url.includes('_normal.')) return 50; return 0;
        };
        const candidateImages = input.images
            .filter(imgUrl => typeof imgUrl === 'string' && imgUrl && !/svg|profile_images|avatar|profile_banners|spacer|blank|1x1/i.test(imgUrl))
            .map(imgUrl => ({ url: imgUrl, isJpeg: /\.(jpg|jpeg)(\?.*)?$/i.test(imgUrl) || /format=(jpg|jpeg)/i.test(imgUrl), rank: getImageSizeRank(imgUrl) }))
            .sort((a, b) => (b.rank !== a.rank) ? (b.rank - a.rank) : (b.isJpeg - a.isJpeg));
        if (candidateImages.length > 0) newObject.ogResult.ogImage.push({ url: candidateImages[0].url });
    }
    return newObject;
}

function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return unsafe == null ? '' : String(unsafe);
    return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function generatePromptHash(promptText, length = 8) {
    if (!promptText?.length) return 'noPrompt';
    let hash = 0;
    for (let i = 0; i < promptText.length; i++) { hash = ((hash << 5) - hash) + promptText.charCodeAt(i); hash |= 0; }
    return Math.abs(hash).toString(16).padStart(length, '0').substring(0, length);
}

async function urlToGenerativePart(url, mimeType = "image/jpeg") {
    try {
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
        return { inlineData: { data: Buffer.from(res.data, 'binary').toString("base64"), mimeType } };
    } catch (error) { console.error(`Failed to download ${url}: ${error.message}`); return null; }
}

// --- Gemini-based Generation Functions ---

async function processOriginalImageGemini(imageUrl) {
    if (!imageUrl) return "";
    console.log(`Processing original image with Gemini Vision: ${imageUrl}`);
    let imagePart = null;
    try {
        let mimeType = "image/jpeg";
        const ext = path.extname(new URL(imageUrl).pathname).toLowerCase();
        if (ext === '.png') mimeType = "image/png"; else if (ext === '.webp') mimeType = "image/webp";
        imagePart = await urlToGenerativePart(imageUrl, mimeType);
        if (!imagePart) throw new Error("Failed to download/prepare image part.");
    } catch (prepError) { return `<!-- Gemini Vision skip: Could not prepare ${imageUrl}: ${prepError.message} -->\n`; }
    try {
        const result = await geminiVisionModel.generateContent(["Compose a Shakespearean Sonnet for this image.", imagePart]);
        const sonnet = result.response?.text?.();
        if (!sonnet) return `<!-- Gemini Vision skip: No content for ${imageUrl}. -->\n`;
        return `### Sonnet for Original Image (by ${GEMINI_VISION_MODEL_NAME})\n\n![](${encodeURI(imageUrl)})\n\n${sonnet.trim()}\n\n`;
    } catch (error) {
        console.error(`Gemini Vision error (${imageUrl}):`, error.message);
        return "<!-- Gemini Vision processing failed -->\n";
    }
}

async function generateAndEmbedImageGemini(imagePromptContent, baseFilename) {
    const trimmedPrompt = imagePromptContent.trim();
    if (!trimmedPrompt) return { success: false, error: "No valid prompt", markdown: "" };

    console.log(`Generating Gemini image with prompt: "${trimmedPrompt.substring(0, 150)}..."`);
    try {
        const apiResponse = await googleGenAIClient.models.generateImages({
            model: GEMINI_IMAGE_GEN_MODEL_NAME,
            prompt: trimmedPrompt,
            config: { numberOfImages: 1 },
        });

        const generatedImage = apiResponse.generatedImages?.[0];
        if (!generatedImage?.image?.imageBytes) {
            const refusalReason = apiResponse?.promptFeedback?.blockReason || 'No imageBytes returned.';
            throw new Error(`Image generation failed: ${refusalReason}`);
        }

        const imageDataBuffer = Buffer.from(generatedImage.image.imageBytes, 'base64');
        const imageName = `gemini-img-${Date.now()}-${baseFilename}.png`;
        const imagePath = path.join(OUTPUT_IMAGES_DIR, imageName);
        const relativeImagePathForMarkdown = `/${path.basename(OUTPUT_IMAGES_DIR)}/${imageName}`.replace(/\\/g, '/');
        await fs.writeFile(imagePath, imageDataBuffer);
        console.log(`Gemini Image successfully saved as ${imagePath}`);
        
        return {
            success: true,
            markdown: `\n\n![Generated Gemini Image](${relativeImagePathForMarkdown})\n\n`,
            imageBytes: generatedImage.image.imageBytes,
        };
    } catch (error) {
        console.error(`Error in generateAndEmbedImageGemini:`, error.message);
        return { success: false, error: error.message, markdown: `\n\n<!-- Gemini Image Generation Exception: ${escapeHtml(error.message)} -->\n\n` };
    }
}

async function generateAndEmbedVideo(videoPromptContent, baseFilename, imageInput = null) {
    if (!videoPromptContent?.trim()) return { success: false, error: "No valid prompt", modelUsed: "N/A" };
    
    console.log("Attempting video generation with Gemini Veo...");
    const veoResult = await generateAndEmbedVideoVeo(videoPromptContent, baseFilename, imageInput);
    veoResult.modelUsed = `Gemini ${VEO_MODEL_NAME}`;
    return veoResult;
}

async function generateAndEmbedVideoVeo(videoPromptContent, baseFilename, imageInput) {
    const trimmedPrompt = videoPromptContent.trim();
    const logStart = imageInput ? `Generating video (with image input)` : `Generating video (text-only)`;
    console.log(`${logStart} via Veo: "${trimmedPrompt.substring(0, 100)}..."`);
    
    try {
        const videoRequest = {
            model: VEO_MODEL_NAME, prompt: trimmedPrompt
            // , config: { aspectRatio: "16:9" },
        };
        if (imageInput) videoRequest.image = { imageBytes: imageInput.imageBytes, mimeType: "image/png" };

        let operation = await googleGenAIClient.models.generateVideos(videoRequest);
        while (!operation.done) {
            await new Promise((resolve) => setTimeout(resolve, 5000)); // Check every 5 seconds
            operation = await googleGenAIClient.operations.getVideosOperation({ operation });
        }

        const generatedVideos = operation.response?.generatedVideos;
        if (!generatedVideos || generatedVideos.length === 0) throw new Error(operation.response?.promptFeedback?.blockReason || 'No video data returned.');
        
        let markdown = "";
        for (const [i, generatedVideo] of generatedVideos.entries()) {
            if (!generatedVideo.video?.uri) continue;
            const videoName = `gemini-video-veo-${Date.now()}-${baseFilename}-${i}.mp4`;
            const videoPath = path.join(OUTPUT_IMAGES_DIR, videoName);
            const relativeVideoPath = `/${path.basename(OUTPUT_IMAGES_DIR)}/${videoName}`.replace(/\\/g, '/');
            const resp = await fetch(`${generatedVideo.video.uri}&key=${geminiApiKey}`);
            if (resp.ok) {
                const writer = createWriteStream(videoPath);
                await new Promise((resolve, reject) => { Readable.fromWeb(resp.body).pipe(writer).on('finish', resolve).on('error', reject); });
                markdown += `\n<video controls width="100%"><source src="${relativeVideoPath}" type="video/mp4"></video>\n`;
            }
        }
        return { success: true, markdown: markdown.trim() };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// --- Main Processing Logic ---

async function processSingleFile(inputFile, selectedPrompt) {
    currentInputFile = inputFile; currentInputPath = path.join(INPUT_DATA_DIR, inputFile);
    const baseFilename = path.basename(inputFile, '.json');
    console.log(`\n--- Processing: ${inputFile} with Grok Prompt: ${selectedPrompt.name} ---`);
    try {
        let inputData = JSON.parse(await fs.readFile(currentInputPath, 'utf8'));
        if (inputData.content && !inputData.ogResult) inputData = transformInputJson(inputData);
        if (!inputData.ogResult) { console.warn(`Skipping ${inputFile}: Unknown structure.`); return; }
        
        inputData.ogResult.ogTitle = inputData.ogResult.ogTitle || inputData.name || 'Untitled';
        await fs.writeFile(path.join(JSON_COPY_DIR, inputFile), JSON.stringify(inputData, null, 2));
        const originalImageUrl = inputData.ogResult.ogImage?.[0]?.url;

        let fullTextContent = [ inputData.ogResult?.ogTitle, inputData.ogResult?.ogDescription, inputData.ogResult?.ogUrl ].filter(Boolean).join('\n\n');
        const cleanedHtml = (inputData.ogHTML || '').replace(/<style[^>]*>.*?<\/style>|<script[^>]*>.*?<\/script>|<[^>]+>/gis, ' ').replace(/\s{2,}/g, ' ').trim();
        if (cleanedHtml) fullTextContent += `\n\n${cleanedHtml}`;
        if (!fullTextContent.trim()) { console.warn(`Skipping ${inputFile}: No text content.`); return; }

        const textChunks = [];
        for (let i = 0; i < fullTextContent.length; i += MAX_CHUNK_SIZE_CHARS) textChunks.push(fullTextContent.substring(i, i + MAX_CHUNK_SIZE_CHARS));
        if (textChunks.length === 0) { console.warn(`Skipping ${inputFile}: No chunks from content.`); return; }

        const textApiPromises = textChunks.map((chunk) => {
            const userPrompt = selectedPrompt.chat.replace('[[chunk]]', chunk);
            return grokClient.chat.completions.create({
                model: TEXT_MODEL_NAME,
                messages: [{ role: "system", content: selectedPrompt.system }, { role: "user", content: userPrompt }],
                temperature: 1.0,
        search_parameters: {
            mode: "on", // As previously modified
            max_search_results: 5
        },
        sources: [
            { type: "web" },
            { type: "x" }
]
            }).catch(err => ({ error: true, message: err.message }));
        });

        const [geminiSonnetResult, ...textApiResults] = await Promise.all([ 
            processOriginalImageGemini(originalImageUrl), 
            ...textApiPromises 
        ]);

        let combinedVerseOutput = "", toc = "## Table of Contents\n";
        const extractedImagePrompts = [], extractedVideoPrompts = [];
        
        textApiResults.forEach((result, index) => {
            const chunkNum = index + 1;
            toc += `- [Verse ${chunkNum}](#v${chunkNum})\n`;

            if (result.error) {
                combinedVerseOutput += `<h3 id="v${chunkNum}">Verse ${chunkNum}</h3><p><em>Error: ${result.message}</em></p>\n`;
                return;
            }
            const messageContent = result.choices?.[0]?.message?.content?.trim();
            if (!messageContent) {
                combinedVerseOutput += `<h3 id="v${chunkNum}">Verse ${chunkNum}</h3><p><em>No content.</em></p>\n`;
                return;
            }

            // --- START: CORRECTED Regex-based Parsing ---
            const sections = { verse: '', image: '', video: '' };

            // This regex captures text after a header, ignoring emojis/text on the header line,
            // and stopping before metadata like "(Word count:...)".
            const imagePromptRegex = /###\s*Image Prompt.*[\r\n]+([\s\S]*?)(?:\(\s*word count:|###|$)/i;
            const videoPromptRegex = /###\s*Video Prompt.*[\r\n]+([\s\S]*?)(?:\(\s*word count:|###|$)/i;

            const imagePromptMatch = messageContent.match(imagePromptRegex);
            const videoPromptMatch = messageContent.match(videoPromptRegex);

            if (imagePromptMatch && imagePromptMatch[1]) {
                const promptText = imagePromptMatch[1].trim();
                if (promptText) {
                    sections.image = promptText;
                    extractedImagePrompts.push(sections.image);
                    console.log(`✅ Extracted Image Prompt from chunk ${chunkNum}.`);
                }
            }
            if (videoPromptMatch && videoPromptMatch[1]) {
                const promptText = videoPromptMatch[1].trim();
                if (promptText) {
                    sections.video = promptText;
                    extractedVideoPrompts.push(sections.video);
                    console.log(`✅ Extracted Video Prompt from chunk ${chunkNum}.`);
                }
            }

            let firstPromptIndex = messageContent.length;
            if (imagePromptMatch) firstPromptIndex = Math.min(firstPromptIndex, imagePromptMatch.index);
            if (videoPromptMatch) firstPromptIndex = Math.min(firstPromptIndex, videoPromptMatch.index);

            sections.verse = messageContent.substring(0, firstPromptIndex)
                                       .replace(/###\s*Verse\s*(\d*)\s*[\r\n]*/i, '')
                                       .trim();

            const verse = sections.verse || messageContent; // Fallback to full content
            combinedVerseOutput += `<h3 id="v${chunkNum}">Verse ${chunkNum}</h3><div>${escapeHtml(verse).replace(/\n/g,'<br>')}</div>\n`;
            // --- END: CORRECTED Parsing ---
        });
        
        if(extractedImagePrompts.length > 0 || extractedVideoPrompts.length > 0) {
            toc += `- [Generated Media](#generated-media)\n`;
        }

        let figureWithGeminiImage = "<!-- No image prompts found in Grok output -->";
        let imageInputForVideo = null;
        let promptsForDisplay = "";

        if (extractedImagePrompts.length > 0) {
            const promptForImage = extractedImagePrompts[Math.floor(Math.random() * extractedImagePrompts.length)];
            const geminiImgRes = await generateAndEmbedImageGemini(promptForImage, baseFilename);
            if (geminiImgRes.success) {
                figureWithGeminiImage = `### Generated Image (by ${GEMINI_IMAGE_GEN_MODEL_NAME})\n${geminiImgRes.markdown}`;
                promptsForDisplay += `\n<p><strong>Prompt for Image:</strong></p><pre><code>${escapeHtml(promptForImage)}</code></pre>`;
                if (geminiImgRes.imageBytes) imageInputForVideo = { imageBytes: geminiImgRes.imageBytes };
            } else {
                figureWithGeminiImage = `### Gemini Image Generation Failed\n<p>${escapeHtml(geminiImgRes.error)}</p>`;
            }
        }
        
        let generatedVideoOutput = "<!-- No video prompts found in Grok output -->";
        let videoModelUsed = "N/A";

        if (extractedVideoPrompts.length > 0) {
            const promptForVideo = extractedVideoPrompts[Math.floor(Math.random() * extractedVideoPrompts.length)];
            const videoGenRes = await generateAndEmbedVideo(promptForVideo, baseFilename, imageInputForVideo);
            videoModelUsed = videoGenRes.modelUsed || "N/A";
            if (videoGenRes.success) {
                generatedVideoOutput = `### Generated Video (by Gemini Veo)\n${videoGenRes.markdown}`;
                promptsForDisplay += `\n<p><strong>Prompt for Video:</strong></p><pre><code>${escapeHtml(promptForVideo)}</code></pre>`;
            } else {
                generatedVideoOutput = `### Generated Video\n<p><strong>Video Generation Failed.</strong> Error: ${escapeHtml(videoGenRes.error || 'Unknown error')}</p>`;
            }
        }

        const promptHash = generatePromptHash(selectedPrompt.system + selectedPrompt.chat);
        const safeTitle = (inputData.ogResult.ogTitle || baseFilename).replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/\s+/g, '_').substring(0, 50);
        const modelNameClean = TEXT_MODEL_NAME.replace(/[^a-zA-Z0-9.-]/g, '');
        const outputFilename = `${safeTitle}-${modelNameClean}-Gemini-Hybrid.md`;
        const outputPath = path.join(OUTPUT_POSTS_DIR, outputFilename);

        const uniqueToc = [...new Set(toc.split('\n'))].join('\n');

        const mdOutput = `---
title: "${escapeHtml(inputData.ogResult.ogTitle || 'Untitled')} | ${modelNameClean} & Gemini"
author: "Grok & Gemini"
---
Source: [${inputData.ogResult.ogUrl || 'N/A'}](${inputData.ogResult.ogUrl || '#'})
${uniqueToc}<hr>
## Creative Text (by ${TEXT_MODEL_NAME})
${combinedVerseOutput}<hr>
## Vision Sonnet on Original Image
${geminiSonnetResult}<hr>
<h2 id="generated-media">Generated Media</h2>
${figureWithGeminiImage}
<hr>
${generatedVideoOutput}
<hr>
<h3 id="prompts">Prompts Used (Generated by ${TEXT_MODEL_NAME})</h3>
${promptsForDisplay}
<hr>
### Generation Details
<details><summary>Models & Prompt</summary>
<p><strong>Text Engine:</strong> ${TEXT_MODEL_NAME}<br>
<strong>Vision Model:</strong> ${GEMINI_VISION_MODEL_NAME}<br>
<strong>Image Gen Model:</strong> ${GEMINI_IMAGE_GEN_MODEL_NAME}<br>
<strong>Video Gen Model:</strong> ${videoModelUsed}</p>
<p><strong>Base Prompt (${selectedPrompt.name}):</strong></p><strong>System:</strong><pre><code>${escapeHtml(selectedPrompt.system)}</code></pre><strong>Chat:</strong><pre><code>${escapeHtml(selectedPrompt.chat)}</code></pre></details>`;
        
        await fs.writeFile(outputPath, mdOutput);
        console.log(`Generated: ${outputPath}`);
    } catch (error) {
        console.error(`\n--- ERROR processing ${currentInputFile} ---`, error.stack || error);
    }
}

async function main() {
    console.log("Starting Grok-to-Gemini Hybrid Script...");
    try {
        await fs.mkdir(OUTPUT_POSTS_DIR, { recursive: true });
        await fs.mkdir(OUTPUT_IMAGES_DIR, { recursive: true });
        await fs.mkdir(JSON_COPY_DIR, { recursive: true });
        await loadAndPreparePrompts();
        if (availablePrompts.length === 0) { console.error("FATAL: No prompts. Exiting."); process.exit(1); }
        
        const promptIdx = getNextPromptIndexSync();
        const selPrompt = availablePrompts[promptIdx];
        console.log(`Selected base prompt: ${selPrompt.name} (Index: ${promptIdx})`);
        setPromptIndexSync(promptIdx);

        const files = await fs.readdir(INPUT_DATA_DIR).catch(() => { console.error(`Input dir ${INPUT_DATA_DIR} not found.`); process.exit(1); });
        const jsonFiles = files.filter(f => path.extname(f).toLowerCase() === '.json');
        if (jsonFiles.length === 0) { console.log(`No JSON files in ${INPUT_DATA_DIR}.`); return; }

        console.log(`Found ${jsonFiles.length} JSON files to process.`);
        for (const file of jsonFiles) {
            await processSingleFile(file, selPrompt);
        }
        console.log("\n--- Script finished ---");
    } catch (error) {
        console.error("\n--- FATAL ERROR ---", error.stack || error);
        process.exit(1);
    }
}

main();
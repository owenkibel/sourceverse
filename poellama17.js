const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');
const ollama = require('ollama').default;
const { encode } = require('node-base64-image');
const yargs = require('yargs');

// --- Configuration ---
const config = {
    inputDataDir: 'ogs_data',
    jsonCopyDir: 'json',
    promptsDir: path.join(__dirname, 'prompts'),
    outputPostsDir: 'posts',
    outputImagePromptsDir: 'image_prompts',
    promptStateFile: path.join(__dirname, 'ollama.txt'),
    avgCharsPerToken: 4,
    minChunkSize: 500, // Minimum chunk size to avoid low-quality outputs
    visionModelPatterns: [/minicpm/i, /gemma3/i, /llama3\.2-vision/i, /llava/i],
    textIneligiblePatterns: [/embed/i, /-vision/i, /minicpm/i]
};

// Command-line arguments
const argv = yargs
    .option('chunk-size', {
        type: 'number',
        description: 'Maximum chunk size in characters',
        default: null // Will use dynamic size if not specified
    })
    .option('save-all-prompts', {
        type: 'boolean',
        description: 'Save all image prompts instead of one',
        default: false
    })
    .argv;

// --- Ollama Model Setup ---
const TEMP_TEXT_MODEL_NAME = 'verse-temp';
let availableModels = [];
let availableVisionModels = [];
let selectedTextModelName = '';
let selectedVisionModelName = '';
let MAX_CHUNK_TOKEN_ESTIMATE = 1000; // Global, will be updated
let MAX_CHUNK_SIZE_CHARS = MAX_CHUNK_TOKEN_ESTIMATE * config.avgCharsPerToken;

async function getModelContextSize(modelName) {
    try {
        const modelInfo = await ollama.show({ model: modelName });
        return modelInfo.parameters?.num_ctx || 1000;
    } catch (error) {
        console.warn(`Could not fetch context size for ${modelName}:`, error.message);
        return 1000;
    }
}

async function setupOllamaModels() {
    try {
        const modelListResponse = await ollama.list();
        const allLocalModels = modelListResponse.models.map(model => model.name);
        console.log("Available Ollama models:", allLocalModels.join(', '));

        // Identify Vision Models
        availableVisionModels = allLocalModels.filter(modelName =>
            config.visionModelPatterns.some(pattern => pattern.test(modelName))
        );
        if (availableVisionModels.length === 0) {
            console.warn("Warning: No known vision models found. Vision processing will fail.");
            selectedVisionModelName = "vision-model-not-found";
        } else {
            selectedVisionModelName = availableVisionModels[Math.floor(Math.random() * availableVisionModels.length)];
            console.log(`Selected Vision Model: ${selectedVisionModelName}`);
        }

        // Identify Text Models
        const textModels = allLocalModels.filter(modelName => {
            const isIneligible = config.textIneligiblePatterns.some(pattern => pattern.test(modelName));
            return !isIneligible;
        });
        if (textModels.length === 0) {
            throw new Error("No suitable text generation models found.");
        }
        selectedTextModelName = textModels[Math.floor(Math.random() * textModels.length)];
        console.log(`Selected Text Model (Base): ${selectedTextModelName}`);

        // Set dynamic chunk size
        const contextSize = await getModelContextSize(selectedTextModelName);
        MAX_CHUNK_TOKEN_ESTIMATE = Math.floor(contextSize * 0.8);
        MAX_CHUNK_SIZE_CHARS = argv.chunkSize || (MAX_CHUNK_TOKEN_ESTIMATE * config.avgCharsPerToken);
        console.log(`Set chunk size to ${MAX_CHUNK_SIZE_CHARS} chars for ${selectedTextModelName}`);
    } catch (error) {
        console.error("FATAL: Error setting up Ollama models:", error);
        throw error;
    }
}

// --- Globals ---
let currentInputFile = '';
let currentInputPath = '';
let candidateImages = [];
let primaryImageUrl;

// --- Prompt Management ---
let availablePrompts = [];

async function loadPromptFile(filePath) {
    try {
        const fileContent = await fs.readFile(filePath, 'utf8');
        return JSON.parse(fileContent);
    } catch (error) {
        console.error(`Error loading prompt from ${filePath}:`, error);
        throw new Error(`Failed to load prompt file: ${filePath}.`);
    }
}

async function loadAndPreparePrompts() {
    availablePrompts = [];
    try {
        const promptFiles = await fs.readdir(config.promptsDir);
        console.log(`Found prompt files: ${promptFiles.join(', ')}`);

        for (const file of promptFiles) {
            if (path.extname(file).toLowerCase() !== '.json') {
                console.warn(`Skipping non-JSON file: ${file}`);
                continue;
            }
            const filePath = path.join(config.promptsDir, file);
            const promptData = await loadPromptFile(filePath);

            if (!promptData.system || !promptData.chat) {
                console.warn(`Skipping ${file}: Missing 'system' or 'chat' property.`);
                continue;
            }

            let systemPrompt = promptData.system.replace(/"/g, '\\"').replace(/\n/g, '\\n');
            let chatPrompt = promptData.chat;
            const style = promptData.style?.[Math.floor(Math.random() * (promptData.style?.length || 1))] || "";
            const poet = promptData.poet?.[Math.floor(Math.random() * (promptData.poet?.length || 1))] || "";

            systemPrompt = systemPrompt.replace(/\[\[verseStyle]]/g, style).replace(/\[\[poet]]/g, poet);
            chatPrompt = chatPrompt.replace(/\[\[verseStyle]]/g, style).replace(/\[\[poet]]/g, poet);

            if (!chatPrompt.includes('[[chunk]]')) {
                console.warn(`Prompt ${file} missing '[[chunk]]'. Appending chunk.`);
                chatPrompt += "\n\nAnalyze the following text:\n[[chunk]]";
            }

            availablePrompts.push({
                name: path.basename(file, '.json'),
                system: systemPrompt,
                chat: chatPrompt,
                style,
                poet
            });
        }

        if (availablePrompts.length === 0) {
            throw new Error(`No valid prompt files found in ${config.promptsDir}.`);
        }
        console.log(`Loaded ${availablePrompts.length} prompts.`);
    } catch (error) {
        console.error("Error loading prompts:", error);
        throw error;
    }
}

function getNextPromptIndexSync() {
    try {
        if (availablePrompts.length === 0) return 0;
        const data = fss.readFileSync(config.promptStateFile, 'utf-8');
        const index = parseInt(data.trim(), 10);
        if (isNaN(index) || index < 0) return 0;
        return (index + 1) % availablePrompts.length;
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`Prompt state file not found. Starting from index 0.`);
        } else {
            console.warn(`Warning reading prompt state file:`, error.message);
        }
        return 0;
    }
}

function setPromptIndexSync(index) {
    try {
        fss.writeFileSync(config.promptStateFile, String(index), 'utf-8');
    } catch (error) {
        console.error(`Error writing prompt state file:`, error);
    }
}

// --- Input Data Transformation ---
function transformInputJson(input) {
    candidateImages = [];
    const newObject = {
        name: input.title || input.name || 'Untitled',
        url: input.source || input.url || '',
        ogResult: {
            ogTitle: input.title || input.name || 'Untitled',
            ogDescription: input.description || '',
            ogUrl: input.source || input.url || '',
            ogImage: [],
            ...(input.ogResult || {})
        },
        ogHTML: input.content || input.ogHTML || '',
        ogLength: (input.content || input.ogHTML || '').length,
        youtube: input.youtube || {},
        images: input.images || []
    };

    let allPossibleImages = [];
    if (input.images && Array.isArray(input.images) && input.images.length > 0) {
        allPossibleImages = input.images
            .map(img => typeof img === 'string' ? img : img?.src)
            .filter(src => typeof src === 'string' && src);
    } else if (input.ogResult && input.ogResult.ogImage) {
        if (Array.isArray(input.ogResult.ogImage)) {
            allPossibleImages = input.ogResult.ogImage
                .map(img => img?.url || (typeof img === 'string' ? img : null))
                .filter(Boolean);
        } else if (typeof input.ogResult.ogImage === 'string') {
            allPossibleImages = [input.ogResult.ogImage];
        }
    }

    if (allPossibleImages.length > 0) {
        const getImageSizeRank = (url) => {
            try {
                const urlParams = new URLSearchParams(new URL(url).search);
                const nameParam = urlParams.get('name');
                if (nameParam) {
                    if (nameParam.toLowerCase() === 'orig') return 10000;
                    if (nameParam.toLowerCase() === 'large') return 5000;
                    if (nameParam.toLowerCase() === 'medium') return 4000;
                    const dimensionMatch = nameParam.match(/^(\d+)x(\d+)$/);
                    if (dimensionMatch) {
                        const width = parseInt(dimensionMatch[1], 10);
                        const height = parseInt(dimensionMatch[2], 10);
                        return width * height;
                    }
                    if (nameParam.toLowerCase() === 'small') return 1000;
                    if (nameParam.toLowerCase() === 'thumb') return 500;
                    if (nameParam.toLowerCase() === 'tiny') return 100;
                }
            } catch (e) { /* ignore */ }
            if (url.includes('_bigger.')) return 75;
            if (url.includes('_normal.')) return 50;
            if (url.includes('_mini.')) return 25;
            return 0;
        };

        candidateImages = allPossibleImages
            .filter(imageUrl => {
                if (typeof imageUrl !== 'string' || !imageUrl) return false;
                const lowerCaseUrl = imageUrl.toLowerCase();
                const isSvgData = lowerCaseUrl.startsWith('data:image/svg+xml');
                const isSvgExtension = lowerCaseUrl.endsWith('.svg');
                const isProfile = lowerCaseUrl.includes('/profile_images/') || lowerCaseUrl.includes('avatar');
                const isBanner = lowerCaseUrl.includes('/profile_banners/');
                const isSpacer = /spacer|blank|1x1/.test(lowerCaseUrl);
                const isData = lowerCaseUrl.startsWith('data:');
                return !(isSvgData || isSvgExtension || isProfile || isBanner || isSpacer || isData);
            })
            .map(imageUrl => ({
                url: imageUrl,
                isJpeg: /\.(jpe?g)(\?.*)?$/i.test(imageUrl.toLowerCase()) || /format=(jpe?g)/i.test(imageUrl.toLowerCase()),
                rank: getImageSizeRank(imageUrl)
            }))
            .sort((a, b) => {
                if (b.rank !== a.rank) return b.rank - a.rank;
                if (a.isJpeg !== b.isJpeg) return b.isJpeg - a.isJpeg;
                return 0;
            });

        console.log('[Transform Debug] Candidate Images Ranked:', JSON.stringify(candidateImages.slice(0, 5), null, 2));
        if (candidateImages.length > 0) {
            const bestImage = candidateImages[0].url;
            console.log(`[Transform Debug] Selected Best Image: ${bestImage} (Rank: ${candidateImages[0].rank})`);
            newObject.ogResult.ogImage = [{ url: bestImage }];
        } else {
            console.log('[Transform Debug] No suitable candidate image found.');
            newObject.ogResult.ogImage = [];
        }
    } else {
        console.log('[Transform Debug] No images array or ogImage found.');
        newObject.ogResult.ogImage = [];
    }

    return newObject;
}

// --- Image Prompt Saving ---
async function saveImagePromptToFile(promptContent, baseFilename, promptHash, chunkIndex = null) {
    if (!promptContent || typeof promptContent !== 'string' || promptContent.trim().length === 0) {
        console.warn("Skipping saving image prompt: Content is empty.");
        return false;
    }
    const safeBase = baseFilename.replace(/[^a-zA-Z0-9_-]/g, '_');
    const promptFilename = chunkIndex !== null ? `${safeBase}-chunk${chunkIndex}-${promptHash}.txt` : `${safeBase}-${promptHash}.txt`;
    const promptFilePath = path.join(config.outputImagePromptsDir, promptFilename);

    try {
        await fs.mkdir(config.outputImagePromptsDir, { recursive: true });
        await fs.writeFile(promptFilePath, promptContent.trim());
        console.log(`Saved image prompt to: ${promptFilePath}`);
        return true;
    } catch (error) {
        console.error(`Error saving image prompt to ${promptFilePath}:`, error);
        return false;
    }
}

async function saveAllImagePrompts(prompts, baseFilename, promptHash) {
    if (!prompts.length) return false;
    let success = true;
    for (let i = 0; i < prompts.length; i++) {
        const saved = await saveImagePromptToFile(prompts[i], baseFilename, promptHash, i + 1);
        if (!saved) success = false;
    }
    return success;
}

// --- Core Processing Logic ---
async function processOriginalImage(imageUrl) {
    if (!imageUrl || typeof imageUrl !== 'string') {
        console.log("No valid image URL for vision processing.");
        return "";
    }
    if (selectedVisionModelName === "vision-model-not-found") {
        console.warn("Skipping vision processing: No vision model available.");
        return "<!-- Vision processing skipped: No vision model available -->\n\n";
    }

    console.log(`Processing image with ${selectedVisionModelName}: ${imageUrl}`);
    let base64Image;
    try {
        base64Image = await encode(imageUrl, { string: true });
        if (!base64Image) throw new Error("Encoding image returned empty.");
    } catch (error) {
        console.error(`Error encoding image ${imageUrl}:`, error.message);
        return "<!-- Vision processing failed: Could not encode image -->\n\n";
    }

    try {
        const visionUserPrompt = "Compose a descriptive Shakespearean Sonnet inspired by this image.";
        const response = await ollama.chat({
            model: selectedVisionModelName,
            messages: [{ role: 'user', content: visionUserPrompt, images: [base64Image] }],
        });

        const sonnet = response?.message?.content?.trim() || "";
        if (!sonnet) {
            console.warn("Vision model returned empty content for image:", imageUrl);
            return "<!-- Vision processing returned no content -->\n\n";
        }
        const encodedImageUrl = encodeURI(imageUrl);
        return `### Sonnet for Primary Image\n\nSelected image processed by vision model:\n\n![](${encodedImageUrl})\n\n${sonnet}\n\n`;
    } catch (error) {
        console.error(`Error processing image ${imageUrl} with ${selectedVisionModelName}:`, error.message);
        return "<!-- Vision processing failed -->\n\n";
    }
}

async function processSingleFile(inputFile, selectedPrompt) {
    candidateImages = [];
    currentInputFile = inputFile;
    currentInputPath = path.join(config.inputDataDir, inputFile);
    const baseFilename = path.basename(inputFile, '.json');

    console.log(`\n--- Processing File: ${inputFile} with Prompt: ${selectedPrompt.name} (Text Model: ${TEMP_TEXT_MODEL_NAME}) ---`);
    console.log(`Using chunk size: ${MAX_CHUNK_SIZE_CHARS} characters${argv.chunkSize ? ' (set via --chunk-size)' : ' (dynamic based on model context)'}, minimum: ${config.minChunkSize} characters`);

    try {
        // 1. Read and Parse Input JSON
        const rawJsonContent = await fs.readFile(currentInputPath, 'utf8');
        let inputData = JSON.parse(rawJsonContent);

        // 2. Transform if necessary
        if (!inputData.ogResult && (inputData.content || inputData.images)) {
            console.log(`Applying transformation for ${inputFile}...`);
            inputData = transformInputJson(inputData);
        } else if (!inputData.images && inputData.ogResult?.ogImage) {
            console.warn(`Missing 'images' array in ${inputFile}. Reconstructing from ogResult.ogImage.`);
            inputData.images = (Array.isArray(inputData.ogResult.ogImage) ? inputData.ogResult.ogImage : [inputData.ogResult.ogImage])
                .map(img => ({ src: img?.url || (typeof img === 'string' ? img : null), alt: null }))
                .filter(img => img.src);
            inputData = transformInputJson(inputData);
        } else if (!inputData.images) {
            inputData.images = [];
        }

        // Ensure essential fields
        inputData.ogResult = inputData.ogResult || {};
        inputData.ogResult.ogTitle = inputData.ogResult.ogTitle || inputData.name || 'Untitled';
        inputData.ogResult.ogUrl = inputData.ogResult.ogUrl || inputData.url || '';
        inputData.ogHTML = inputData.ogHTML || '';
        inputData.ogResult.ogImage = Array.isArray(inputData.ogResult.ogImage) ? inputData.ogResult.ogImage : (inputData.ogResult.ogImage ? [inputData.ogResult.ogImage] : []);
        inputData.youtube = inputData.youtube || {};
        inputData.images = inputData.images || [];

        // 3. Create JSON Copy
        const jsonCopyFilename = inputFile;
        const jsonCopyPath = path.join(config.jsonCopyDir, jsonCopyFilename);
        await fs.writeFile(jsonCopyPath, JSON.stringify(inputData, null, 2));
        console.log(`Copied JSON to ${jsonCopyPath}`);

        // 4. Extract Primary Image URL
        primaryImageUrl = inputData.ogResult.ogImage[0]?.url || null;

        // 5. Aggregate Text Content & Clean
        let fullTextContent = [
            inputData.ogResult?.ogUrl ?? '',
            inputData.ogResult?.ogTitle ?? '',
            inputData.ogResult?.ogDescription ?? '',
            inputData.youtube?.subtitles ?? ''
        ].filter(Boolean).join('\n');
        let jsonLdUsed = false;
        if (inputData.ogResult?.jsonLD && Array.isArray(inputData.ogResult.jsonLD)) {
            const article = inputData.ogResult.jsonLD.find(item => item.articleBody && typeof item.articleBody === 'string');
            if (article && article.articleBody.trim().length > 50) {
                console.log(`Using JSON-LD articleBody for ${inputFile}.`);
                fullTextContent += `\n\n<blockquote cite="${inputData.ogResult?.ogUrl ?? ''}">Article Content (JSON-LD):\n${escapeHtml(article.articleBody)}</blockquote>`;
                jsonLdUsed = true;
            }
        }
        if (!jsonLdUsed) {
            const cleanedHtmlContent = (inputData.ogHTML ?? '')
                .replace(/<style[^>]*>.*<\/style>/gis, ' ')
                .replace(/<script[^>]*>.*<\/script>/gis, ' ')
                .replace(/<nav[^>]*>.*<\/nav>/gis, ' ')
                .replace(/<header[^>]*>.*<\/header>/gis, ' ')
                .replace(/<footer[^>]*>.*<\/footer>/gis, ' ')
                .replace(/<aside[^>]*>.*<\/aside>/gis, ' ')
                .replace(/<[^>]+>/g, ' ')
                .replace(/ | /gi, ' ')
                .replace(/&/gi, '&').replace(/</gi, '<').replace(/>/gi, '>').replace(/"/gi, '"').replace(/'/gi, "'")
                .replace(/\s{2,}/g, ' ')
                .trim();
            if (cleanedHtmlContent) {
                console.log(`Using cleaned HTML content for ${inputFile}.`);
                fullTextContent += `\n\nPage Content (HTML):\n${cleanedHtmlContent}`;
            }
        }
        fullTextContent = fullTextContent.trim();

        if (fullTextContent.length === 0) {
            console.warn(`Skipping ${inputFile}: No text content found.`);
            return;
        }

        // 6. Process Primary Image
        const imageSonnetPromise = processOriginalImage(primaryImageUrl);

        // 7. Chunk Text Content
        console.log(`Text content length: ${fullTextContent.length} characters`);
        const textChunks = [];
        if (fullTextContent.length <= config.minChunkSize || fullTextContent.length <= MAX_CHUNK_SIZE_CHARS) {
            textChunks.push(fullTextContent);
        } else {
            console.log(`Chunking text using MAX_CHUNK_SIZE_CHARS=${MAX_CHUNK_SIZE_CHARS}, minChunkSize=${config.minChunkSize}...`);
            let startIndex = 0;
            while (startIndex < fullTextContent.length) {
                let endIndex = startIndex + MAX_CHUNK_SIZE_CHARS;
                if (endIndex >= fullTextContent.length) {
                    endIndex = fullTextContent.length;
                } else {
                    let breakPoint = -1;
                    const searchWindowStart = Math.max(startIndex, endIndex - 200);
                    const sentenceEnd = fullTextContent.substring(searchWindowStart, endIndex).lastIndexOf('.');
                    if (sentenceEnd !== -1 && sentenceEnd > 0) {
                        breakPoint = searchWindowStart + sentenceEnd + 1;
                    } else {
                        const lastSpace = fullTextContent.lastIndexOf(' ', endIndex);
                        if (lastSpace > startIndex && endIndex - lastSpace < 200) {
                            breakPoint = lastSpace;
                        }
                    }
                    if (breakPoint > startIndex) {
                        endIndex = breakPoint;
                    }
                }
                const trimmedChunk = fullTextContent.substring(startIndex, endIndex).trim();
                if (trimmedChunk.length < config.minChunkSize && textChunks.length > 0) {
                    textChunks[textChunks.length - 1] += `\n\n${trimmedChunk}`;
                    console.log(`Merged small chunk (${trimmedChunk.length} chars) into chunk ${textChunks.length}`);
                } else if (trimmedChunk.length > 0) {
                    textChunks.push(trimmedChunk);
                    console.log(`Created chunk ${textChunks.length} (${trimmedChunk.length} chars)`);
                }
                startIndex = endIndex;
            }
            console.log(`Split into ${textChunks.length} chunks.`);
            if (textChunks.length === 0) {
                console.warn(`Skipping ${inputFile}: No usable chunks.`);
                return;
            }
        }

        // 8. Log Chunks for Debugging
        const debugLogPath = `logs/chunks-${Date.now()}.txt`;
        await fs.mkdir('logs', { recursive: true });
        await fs.writeFile(debugLogPath, `File: ${inputFile}\nChunk Size: ${MAX_CHUNK_SIZE_CHARS} chars (min: ${config.minChunkSize})\n`);
        for (let i = 0; i < textChunks.length; i++) {
            await fs.appendFile(debugLogPath, `Chunk ${i + 1} (${textChunks[i].length} chars):\n${textChunks[i]}\n\n`);
        }
        console.log(`Logged chunks to ${debugLogPath}`);

        // 9. Prepare Text Chunk API Calls with Streaming
        const textApiPromises = textChunks.map(async (chunk, index) => {
            console.log(`Preparing API call for chunk ${index + 1}/${textChunks.length} using ${TEMP_TEXT_MODEL_NAME} (${chunk.length} chars)`);
            const userMessageContent = selectedPrompt.chat.replace('[[chunk]]', chunk);
            try {
                let retries = 0;
                const maxRetries = 2;
                while (retries < maxRetries) {
                    const stream = await ollama.chat({
                        model: TEMP_TEXT_MODEL_NAME,
                        messages: [{ role: 'user', content: userMessageContent }],
                        stream: true,
                        options: { temperature: 1.0 }
                    });
                    let content = '';
                    let tokenCount = 0;
                    console.log(`Streaming response for chunk ${index + 1}...`);
                    for await (const part of stream) {
                        const partContent = part.message?.content || '';
                        content += partContent;
                        tokenCount += partContent.length / config.avgCharsPerToken;
                        process.stdout.write(partContent);
                        if (tokenCount > 200 && !content.toLowerCase().match(/verse|poem|stanza/)) {
                            retries++;
                            console.warn(`Chunk ${index + 1} lacks verse-related keyword after ${tokenCount.toFixed(0)} tokens, retrying (${retries}/${maxRetries})...`);
                            break;
                        }
                    }
                    if (retries === maxRetries) {
                        console.warn(`Chunk ${index + 1} failed after ${maxRetries} retries, using last response.`);
                        return { message: { content: content.trim() } };
                    }
                    if (content && content.toLowerCase().match(/verse|poem|stanza/)) {
                        console.log(`\nFinished streaming chunk ${index + 1}`);
                        return { message: { content: content.trim() } };
                    }
                }
            } catch (err) {
                console.error(`Error processing chunk ${index + 1}:`, err.message);
                return { error: true, chunkIndex: index + 1, message: err.message };
            }
        });

        // 10. Execute API Calls
        console.log("Sending API requests...");
        const [imageSonnetResult, ...textApiResults] = await Promise.all([
            imageSonnetPromise,
            ...textApiPromises
        ]);

        // 11. Process Text API Responses
        let combinedVerseOutput = "";
        let toc = "## Table of Contents\n";
        const extractedImagePrompts = [];

        textApiResults.forEach((res, index) => {
            const chunkNumber = index + 1;
            if (!res || res.error) {
                console.error(`Failed chunk ${chunkNumber}: ${res?.message}`);
                toc += `- ~~Verse ${chunkNumber} (Error)~~ \n`;
                combinedVerseOutput += `<h3 id="verse-${chunkNumber}">Verse ${chunkNumber}</h3>\n\n<p><em>Error processing chunk.</em></p>\n\n`;
                return;
            }

            const messageContent = res?.message?.content?.trim() ?? "";
            if (!messageContent) {
                console.warn(`Empty content for chunk ${chunkNumber}.`);
                toc += `- [Verse ${chunkNumber}](#verse-${chunkNumber}) (Empty)\n`;
                combinedVerseOutput += `<h3 id="verse-${chunkNumber}">Verse ${chunkNumber}</h3>\n\n<p><em>No content.</em></p>\n\n`;
                return;
            }

            const sections = { verse: '', image: '', video: '' };
            let currentSection = 'verse';
            const lines = messageContent.split('\n');
            for (const line of lines) {
                const imageMatch = line.match(/^###\s*Image Prompt\s*$/i);
                const videoMatch = line.match(/^###\s*Video Prompt\s*$/i);
                const verseMatch = line.match(/^###\s*(Verse|Poem|Stanza)\s*(\d*)\s*$/i);
                if (imageMatch) currentSection = 'image';
                else if (videoMatch) currentSection = 'video';
                else if (verseMatch) currentSection = 'verse';
                else if (sections.hasOwnProperty(currentSection)) {
                    sections[currentSection] += line + '\n';
                }
            }
            Object.keys(sections).forEach(key => sections[key] = sections[key]?.trim() ?? '');

            const verseContent = sections.verse || messageContent;
            const imagePromptContent = sections.image;
            const videoPromptContent = sections.video;

            toc += `- [Verse ${chunkNumber}](#verse-${chunkNumber})\n`;
            if (imagePromptContent) {
                toc += `  - [Image Prompt ${chunkNumber}](#image-prompt-${chunkNumber})\n`;
                extractedImagePrompts.push(imagePromptContent);
            }
            if (videoPromptContent) {
                toc += `  - [Video Prompt ${chunkNumber}](#video-prompt-${chunkNumber})\n`;
            }

            combinedVerseOutput += `<h3 id="verse-${chunkNumber}">Verse ${chunkNumber}</h3>\n\n<div>${escapeHtml(verseContent).replace(/\n/g, '<br>')}</div>\n\n`;
            if (imagePromptContent) {
                combinedVerseOutput += `<h4 id="image-prompt-${chunkNumber}">Image Prompt ${chunkNumber}</h4>\n\n<pre><code class="language-text">${escapeHtml(imagePromptContent)}</code></pre>\n\n`;
            }
            if (videoPromptContent) {
                combinedVerseOutput += `<h4 id="video-prompt-${chunkNumber}">Video Prompt ${chunkNumber}</h4>\n\n<pre><code class="language-text">${escapeHtml(videoPromptContent)}</code></pre>\n\n`;
            }
        });

        // 12. Select and Save Image Prompts
        let selectedImagePromptMarkdown = "";
        let promptHash = generatePromptHash(selectedPrompt.system + selectedPrompt.chat);

        if (extractedImagePrompts.length > 0) {
            if (argv.saveAllPrompts) {
                console.log(`Saving ${extractedImagePrompts.length} image prompts...`);
                const saved = await saveAllImagePrompts(extractedImagePrompts, baseFilename, promptHash);
                selectedImagePromptMarkdown = `
### Image Prompts Saved
${extractedImagePrompts.length} image prompt(s) saved for diffusion models.
${saved ? `<!-- Saved to: ${config.outputImagePromptsDir} -->` : "<!-- Error saving prompts -->"}
`;
            } else {
                const randomIndex = Math.floor(Math.random() * extractedImagePrompts.length);
                const promptToSave = extractedImagePrompts[randomIndex];
                console.log(`Selected image prompt (index ${randomIndex}): "${promptToSave.substring(0, 100)}..."`);
                const saved = await saveImagePromptToFile(promptToSave, baseFilename, promptHash);
                selectedImagePromptMarkdown = `
### Selected Image Prompt
Selected prompt saved for potential use.
**Prompt:**
<pre><code class="language-text">${escapeHtml(promptToSave)}</code></pre>
${saved ? `<!-- Saved to: ${config.outputImagePromptsDir}/${baseFilename.replace(/[^a-zA-Z0-9_-]/g, '_')}-${promptHash}.txt -->` : "<!-- Error saving prompt -->"}
`;
            }
        } else {
            console.log("No image prompts extracted.");
            selectedImagePromptMarkdown = "<!-- No image prompts generated -->";
        }

        // 13. Generate Markdown for Candidate Images
        let candidateImagesMarkdown = "### Candidate Images\n\n";
        if (candidateImages && candidateImages.length > 0) {
            console.log(`Generating Markdown for ${candidateImages.length} candidate images.`);
            candidateImagesMarkdown += "Images considered, ordered by quality/size (highest rank used for sonnet):\n\n";
            candidateImages.forEach((imgInfo, index) => {
                if (imgInfo.url && !imgInfo.url.startsWith('data:')) {
                    const encodedUrl = encodeURI(imgInfo.url);
                    candidateImagesMarkdown += `**Candidate ${index + 1} (Rank: ${imgInfo.rank})**\n![Candidate ${index + 1}](${encodedUrl})\n<small>URL: \`${escapeHtml(imgInfo.url)}\`</small>\n\n`;
                }
            });
        } else {
            candidateImagesMarkdown += "No suitable candidate images found.\n";
        }

 // In processSingleFile, Step 14
let bodyImagesMarkdown = "### Other Images in Page Body\n\n";
let otherImagesFound = 0;
primaryImageUrl = inputData.ogResult.ogImage[0]?.url || null;

if (inputData.images && Array.isArray(inputData.images) && inputData.images.length > 0) {
    console.log(`Processing ${inputData.images.length} images for body display...`);
    const displayableBodyImagesData = inputData.images
        .map(imgData => {
            let src = null;
            let alt = null;
            if (typeof imgData === 'string') src = imgData;
            else if (imgData && typeof imgData.src === 'string') {
                src = imgData.src;
                alt = imgData.alt;
            }
            return src ? { src, alt } : null;
        })
        .filter(imgInfo => {
            if (!imgInfo || !imgInfo.src) return false;
            const srcLower = imgInfo.src.toLowerCase();
            if (primaryImageUrl && imgInfo.src === primaryImageUrl) {
                console.log(`Excluding primary image: ${imgInfo.src}`);
                return false;
            }
            if (srcLower.startsWith('data:') || srcLower.endsWith('.svg')) return false;
            if (srcLower.includes('/profile_images/') || srcLower.includes('avatar')) {
                console.log(`Excluding profile image: ${imgInfo.src}`);
                return false;
            }
            return /\.(jpe?g|png)(\?.*)?$/i.test(srcLower) || /[?&](format|fm)=(jpe?g|png)/i.test(srcLower);
        });

    if (displayableBodyImagesData.length > 0) {
        otherImagesFound = displayableBodyImagesData.length;
        console.log(`Found ${otherImagesFound} displayable JPG/PNG images.`);
        bodyImagesMarkdown += `JPG/PNG images in page body (excluding primary, data URLs, SVGs, and profile images):\n\n`;
        displayableBodyImagesData.forEach((imgInfo, index) => {
            const encodedUrl = encodeURI(imgInfo.src);
            const altText = escapeHtml(imgInfo.alt || `Body Image ${index + 1}`);
            bodyImagesMarkdown += `**${altText}**\n![${altText}](${encodedUrl})\n<small>URL: \`${escapeHtml(imgInfo.src)}\`</small>\n\n`;
        });
    }
}
if (otherImagesFound === 0) {
    bodyImagesMarkdown += inputData.images && Array.isArray(inputData.images)
        ? "No additional JPG/PNG images after filtering (excluded primary, SVGs, data URLs, and profile images).\n"
        : "No image array found in input data.\n";
}

        // 15. Construct Final Markdown Output
        const modelNameClean = selectedTextModelName.split(':')[0].replace(/[^a-zA-Z0-9]/g, '');
        const outputFilename = `${baseFilename.replace(/[^a-zA-Z0-9_-]/g, '_')}-${modelNameClean}-${promptHash}.md`;
        const outputPath = path.join(config.outputPostsDir, outputFilename);
        const relativeJsonPath = `/json/${encodeURIComponent(jsonCopyFilename)}`;
        const fmTitle = (inputData.ogResult.ogTitle || 'Untitled').replace(/"/g, "''");

        const markdownOutput = `---
title: "${fmTitle}-${modelNameClean}-${selectedPrompt.name}"
author: Ollama
---

Source: [${inputData.ogResult.ogUrl}](${inputData.ogResult.ogUrl})

${toc}
<hr>

${combinedVerseOutput}

<hr>
${imageSonnetResult}

<hr>
${candidateImagesMarkdown}

<hr>
${bodyImagesMarkdown}

<hr>
${selectedImagePromptMarkdown}

<hr>

### Generation Details
<details>
  <summary>Click to view Models and Prompt</summary>
  <p><strong>Text Model (Base):</strong> ${selectedTextModelName}<br>
  <strong>Temporary Text Model:</strong> ${TEMP_TEXT_MODEL_NAME}<br>
  <strong>Vision Model:</strong> ${selectedVisionModelName}</p>
  <p><strong>Prompt Used (Name: ${selectedPrompt.name}):</strong></p>
  <strong>System Instructions:</strong>
  <pre><code class="language-text">${escapeHtml(selectedPrompt.system.replace(/\\n/g, '\n').replace(/\\"/g, '"'))}</code></pre>
  <strong>Chat Template:</strong>
  <pre><code class="language-text">${escapeHtml(selectedPrompt.chat)}</code></pre>
</details>

<hr>
<button onclick="loadAndDisplayJSON()">View Input JSON Data</button>

<script>
function loadAndDisplayJSON() {
    try {
        window.open('/js${relativeJsonPath}', '_blank') || console.error('Failed to open JSON tab. Ensure server serves: /js${relativeJsonPath}');
    } catch (e) {
        console.error('Error opening JSON:', e);
        alert('Could not open JSON data. Check server configuration.');
    }
}
</script>

<!-- Highlight.js should be included in site template -->
`;

        // 16. Write Output File
        await fs.writeFile(outputPath, markdownOutput);
        console.log(`Generated Markdown: ${outputPath}`);

    } catch (error) {
        console.error(`\n--- ERROR processing ${currentInputFile} ---`);
        console.error(error.stack || error);
    } finally {
        currentInputFile = '';
        currentInputPath = '';
        candidateImages = [];
    }
}

// --- Utility Functions ---
function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') {
        return unsafe === null || undefined ? '' : String(unsafe);
    }
    return unsafe
        .replace(/&/g, "&")
        .replace(/</g, "<")
        .replace(/>/g, ">")
        .replace(/"/g, "\"")
        .replace(/'/g, "'");
}

function generatePromptHash(promptText, length = 8) {
    let hash = 0;
    if (!promptText || typeof promptText !== 'string' || promptText.length === 0) return 'noPrompt';
    for (let i = 0; i < promptText.length; i++) {
        const char = promptText.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    return (hash >>> 0).toString(16).padStart(length, '0').substring(0, length);
}

// --- Main Execution ---
async function main() {
    console.log("Starting Ollama processing script...");
    let tempModelCreated = false;

    try {
        await setupOllamaModels();
        await fs.mkdir(config.outputPostsDir, { recursive: true });
        await fs.mkdir(config.jsonCopyDir, { recursive: true });
        await fs.mkdir(config.outputImagePromptsDir, { recursive: true });
        console.log(`Ensured directories: ${config.outputPostsDir}, ${config.jsonCopyDir}, ${config.outputImagePromptsDir}`);

        await loadAndPreparePrompts();
        const promptIndexToUse = getNextPromptIndexSync();
        if (availablePrompts.length === 0) {
            console.error("FATAL: No valid prompts loaded.");
            process.exit(1);
        }
        const selectedPrompt = availablePrompts[promptIndexToUse];
        console.log(`Selected prompt: ${selectedPrompt.name} (Index: ${promptIndexToUse})`);

        const modelfileContent = `
FROM ${selectedTextModelName}
PARAMETER temperature 1
SYSTEM """${selectedPrompt.system}"""
`;
        console.log(`Creating temporary model '${TEMP_TEXT_MODEL_NAME}'...`);
        try {
            try {
                await ollama.delete({ model: TEMP_TEXT_MODEL_NAME });
                console.log(`Deleted existing temporary model.`);
            } catch (deleteError) {
                if (!deleteError.message.includes('not found') && !deleteError.message.includes('no such file')) {
                    console.warn(`Could not delete temp model:`, deleteError.message);
                }
            }
            await ollama.create({
                name: TEMP_TEXT_MODEL_NAME,
                modelfile: modelfileContent,
                from: selectedTextModelName
            });
            tempModelCreated = true;
            console.log(`Created temporary model: ${TEMP_TEXT_MODEL_NAME}`);
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (createError) {
            console.error(`FATAL: Failed to create model '${TEMP_TEXT_MODEL_NAME}':`, createError);
            process.exit(1);
        }

        setPromptIndexSync(promptIndexToUse);

        let files;
        try {
            files = await fs.readdir(config.inputDataDir);
        } catch (err) {
            if (err.code === 'ENOENT') {
                console.error(`FATAL: Input directory not found: ${config.inputDataDir}`);
                process.exit(1);
            }
            throw err;
        }
        const jsonFiles = files.filter(file => path.extname(file).toLowerCase() === '.json');
        if (jsonFiles.length === 0) {
            console.log(`No JSON files found in ${config.inputDataDir}. Exiting.`);
            return;
        }
        console.log(`Found ${jsonFiles.length} JSON files.`);

        for (const file of jsonFiles) {
            await new Promise(resolve => setTimeout(resolve, 200));
            await processSingleFile(file, selectedPrompt);
        }

        console.log("\n--- Script finished ---");
    } catch (error) {
        console.error("\n--- FATAL ERROR ---");
        console.error(error.stack || error);
        process.exit(1);
    } finally {
        if (tempModelCreated) {
            try {
                console.log(`Deleting temporary model: ${TEMP_TEXT_MODEL_NAME}`);
                await ollama.delete({ model: TEMP_TEXT_MODEL_NAME });
                console.log(`Deleted temporary model.`);
            } catch (deleteError) {
                if (!deleteError.message.includes('not found') && !deleteError.message.includes('no such file')) {
                    console.warn(`Failed to delete temp model:`, deleteError.message);
                }
            }
        }
    }
}

main();
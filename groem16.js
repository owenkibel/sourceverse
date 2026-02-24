

// --- START OF REVISED FILE groem11.js --- // Renamed comment to match filename

// ... (keep previous requires and configurations) ...
const path = require('path');
const fs = require('fs/promises');
const fss = require('fs'); // Keep sync version for simple state file initially
const OpenAI = require("openai"); // Use require for CommonJS
const axios = require("axios");   // Use require for CommonJS

// --- Configuration ---
const INPUT_DATA_DIR = 'ogs_data'; // Directory containing input JSON files
const JSON_COPY_DIR = 'json'; // Subfolder for copies of processed JSONs
const PROMPTS_DIR = path.join(__dirname, 'prompts'); // Directory for prompt templates
const OUTPUT_POSTS_DIR = 'posts'; // Directory for generated Markdown files
const OUTPUT_IMAGES_DIR = 'images'; // Directory for generated images
const PROMPT_STATE_FILE = path.join(__dirname, 'grok.txt'); // File to store the next prompt index

// Chunk Size Parameters
const MAX_CHUNK_TOKEN_ESTIMATE = 8000;
const AVG_CHARS_PER_TOKEN = 4;
const MAX_CHUNK_SIZE_CHARS = MAX_CHUNK_TOKEN_ESTIMATE * AVG_CHARS_PER_TOKEN;

// Initialize OpenAI client (Grok via x.ai)
const apiKey = process.env.XAI_API_KEY;
if (!apiKey) {
    console.error("FATAL: XAI_API_KEY environment variable is not set.");
    process.exit(1);
}
const openai = new OpenAI({
    apiKey: apiKey,
    baseURL: "https://api.x.ai/v1",
});

// Specify Models
const TEXT_MODEL = "grok-3-mini-fast-beta";
// const TEXT_MODEL = "grok-3-mini";

const VISION_MODEL = "grok-2-vision-1212";
const IMAGE_GEN_MODEL = "grok-2-image";
const MAX_IMAGE_PROMPT_LENGTH = 1015; // Define the limit clearly

// --- Globals ---
let currentInputFile = '';
let currentInputPath = '';

// --- Prompt Management ---
// ... (keep loadPromptFile, loadAndPreparePrompts, getNextPromptIndexSync, setPromptIndexSync functions) ...
let availablePrompts = [];

async function loadPromptFile(filePath) {
    try {
        const fileContent = await fs.readFile(filePath, 'utf8');
        return JSON.parse(fileContent);
    } catch (error) {
        console.error(`Error loading or parsing prompt from ${filePath}:`, error);
        throw new Error(`Failed to load/parse prompt file: ${filePath}.`);
    }
}

async function loadAndPreparePrompts() {
    availablePrompts = [];
    try {
        const promptFiles = await fs.readdir(PROMPTS_DIR);
        console.log(`Found prompt files: ${promptFiles.join(', ')}`);

        for (const file of promptFiles) {
            if (path.extname(file).toLowerCase() !== '.json') {
                console.warn(`Skipping non-JSON file in prompts directory: ${file}`);
                continue;
            }

            const filePath = path.join(PROMPTS_DIR, file);
            const promptData = await loadPromptFile(filePath);

            if (!promptData.system || !promptData.chat) {
                console.warn(`Skipping prompt file ${file}: Missing 'system' or 'chat' property.`);
                continue;
            }

            let systemPrompt = promptData.system;
            let chatPrompt = promptData.chat;

            const style = promptData.style && Array.isArray(promptData.style)
                ? promptData.style[Math.floor(Math.random() * promptData.style.length)]
                : "";
            const poet = promptData.poet && Array.isArray(promptData.poet)
                ? promptData.poet[Math.floor(Math.random() * promptData.poet.length)]
                : "";

            systemPrompt = systemPrompt.replace(/\[\[verseStyle]]/g, style);
            systemPrompt = systemPrompt.replace(/\[\[poet]]/g, poet);
            chatPrompt = chatPrompt.replace(/\[\[verseStyle]]/g, style);
            chatPrompt = chatPrompt.replace(/\[\[poet]]/g, poet);

            if (!chatPrompt.includes('[[chunk]]')) {
                 console.warn(`Prompt file ${file}'s chat prompt is missing '[[chunk]]'. Appending chunk implicitly.`);
                 chatPrompt += "\n\nAnalyze the following text:\n[[chunk]]";
            }

            availablePrompts.push({
                name: path.basename(file, '.json'),
                system: systemPrompt,
                chat: chatPrompt,
                style: style,
                poet: poet,
            });
        }

        if (availablePrompts.length === 0) {
            throw new Error(`No valid prompt files found in ${PROMPTS_DIR}.`);
        }
        console.log(`Successfully loaded ${availablePrompts.length} prompts.`);

    } catch (error) {
        console.error("Error loading prompts:", error);
        throw error;
    }
}

function getNextPromptIndexSync() {
    try {
        const data = fss.readFileSync(PROMPT_STATE_FILE, 'utf-8');
        const index = parseInt(data.trim(), 10);
        if (isNaN(index) || index < 0) return 0;
        // Ensure the index wraps around correctly even if the file contains an old index
        // from a previous run where the number of prompts might have changed.
        return (index + 1) % (availablePrompts.length || 1); // Use modulo 1 if length is 0 to avoid NaN/errors, although load should prevent this.
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`Prompt state file (${PROMPT_STATE_FILE}) not found. Starting from index 0.`);
        } else {
            console.warn(`Warning reading prompt state file (${PROMPT_STATE_FILE}):`, error.message);
        }
        return 0;
    }
}


function setPromptIndexSync(index) {
    try {
        fss.writeFileSync(PROMPT_STATE_FILE, String(index), 'utf-8');
    } catch (error) {
        console.error(`Error writing prompt state file (${PROMPT_STATE_FILE}):`, error);
    }
}
// --- Input Data Transformation (Improved for Image Selection) ---
// ... (keep transformInputJson function) ...
function transformInputJson(input) {
    const newObject = {
        name: input.title || 'Untitled',
        url: input.source || '',
        ogResult: {
            ogTitle: input.title || 'Untitled',
            ogDescription: input.description || '', // Keep original description handling if needed
            ogUrl: input.source || '',
            ogImage: [], // Initialize as empty array
        },
        ogHTML: input.content || '',
        ogLength: (input.content || '').length,
        youtube: input.youtube, // Preserve youtube data if present
    };

    if (input.images && Array.isArray(input.images) && input.images.length > 0) {

        // Helper function to get a size rank from URL (higher is better)
        // Prioritizes 'orig', then dimensions, then named sizes
        const getImageSizeRank = (url) => {
            try {
                const urlParams = new URLSearchParams(new URL(url).search);
                const nameParam = urlParams.get('name');

                if (nameParam) {
                    const lowerName = nameParam.toLowerCase();
                    if (lowerName === 'orig') return 10000; // Highest priority
                    if (lowerName === 'large') return 5000;
                    if (lowerName === 'medium') return 4000;
                    // Check for dimension format like '900x900'
                    const dimensionMatch = lowerName.match(/^(\d+)x(\d+)$/);
                    if (dimensionMatch) {
                        const width = parseInt(dimensionMatch[1], 10);
                        const height = parseInt(dimensionMatch[2], 10);
                        // Rank based on area or width (width is often sufficient)
                        return width * height; // Or just return width;
                    }
                    if (lowerName === 'small') return 1000;
                    if (lowerName === 'thumb') return 500;
                     if (lowerName === 'tiny') return 100;

                }
            } catch (e) {
                // Ignore URL parsing errors silently or log if needed
                // console.warn(`Could not parse URL for size rank: ${url}`, e.message);
            }
            // Check for _bigger, _normal patterns as lower priority fallbacks
             const lowerUrl = url.toLowerCase();
             if (lowerUrl.includes('_bigger.')) return 75;
             if (lowerUrl.includes('_normal.')) return 50;
             if (lowerUrl.includes('_mini.')) return 25;

            return 0; // Default rank if no size info found
        };

        const candidateImages = input.images
            .filter(imageUrl => {
                // Basic validation and initial filtering
                if (typeof imageUrl !== 'string' || !imageUrl) return false;
                const lowerCaseUrl = imageUrl.toLowerCase();

                // Exclude known non-content types
                const isSvgData = lowerCaseUrl.startsWith('data:image/svg+xml');
                const isSvgExtension = lowerCaseUrl.endsWith('.svg');
                const isProfile = lowerCaseUrl.includes('/profile_images/'); // More specific check for twitter profile images
                 const isAvatar = lowerCaseUrl.includes('avatar'); // General avatar check
                 const isBanner = lowerCaseUrl.includes('/profile_banners/'); // Exclude banners too
                const isSpacer = /spacer|blank|1x1|transparent/i.test(lowerCaseUrl); // Keep spacer check, add transparent

                if (isSvgData || isSvgExtension || isProfile || isAvatar || isBanner || isSpacer) {
                    return false;
                }

                // --- Prioritize JPG/JPEG ---
                const hasJpegExtension = /\.(jpg|jpeg)(\?.*)?$/i.test(lowerCaseUrl);
                let hasJpegFormatParam = false;
                try {
                     const urlParams = new URLSearchParams(new URL(imageUrl).search);
                     const formatParam = urlParams.get('format')?.toLowerCase();
                     hasJpegFormatParam = (formatParam === 'jpg' || formatParam === 'jpeg');
                } catch { /* Ignore URL parsing errors */ }

                 // Keep if it has a JPG/JPEG extension OR format parameter
                 // Allow other types ONLY if they don't have a format parameter (could be PNG default etc.)
                 // This gives preference to explicitly identified JPEGs
                 const isPotentiallyGood = hasJpegExtension || hasJpegFormatParam || !/format=/.test(lowerCaseUrl);

                return isPotentiallyGood; // Return true if it passes all filters

            })
            .map(imageUrl => ({
                url: imageUrl,
                isJpeg: /\.(jpg|jpeg)(\?.*)?$/i.test(imageUrl.toLowerCase()) || /format=(jpg|jpeg)/i.test(imageUrl.toLowerCase()),
                rank: getImageSizeRank(imageUrl) // Calculate rank for each candidate
            }))
            .sort((a, b) => {
                 // Sort primarily by rank (descending)
                 if (b.rank !== a.rank) {
                     return b.rank - a.rank;
                 }
                 // As a tie-breaker, prefer explicit JPEGs
                 if (a.isJpeg !== b.isJpeg) {
                     return b.isJpeg - a.isJpeg; // true (1) comes before false (0)
                 }
                 // Optional: Tie-breaker by URL length (shorter might be cleaner, debatable)
                 // return a.url.length - b.url.length;
                 return 0; // Keep original order if rank and type are same
             });

            // console.log('[Debug] Candidate Images Ranked:', JSON.stringify(candidateImages.slice(0, 5), null, 2)); // Log top 5 candidates

        // Select the best candidate (first one after sorting)
        if (candidateImages.length > 0) {
            const bestImage = candidateImages[0].url;
            // console.log(`[Debug] Selected Best Image: ${bestImage} (Rank: ${candidateImages[0].rank})`);
            // Push in the required format { url: ... }
            newObject.ogResult.ogImage.push({ url: bestImage });
        } else {
             console.log('[Debug] No suitable candidate image found after filtering and ranking.');
        }
    } else {
         console.log('[Debug] Input has no images array or it is empty.');
    }

    return newObject;
}

// --- Image Generation (REVISED for flexible prompt extraction WITH FALLBACK) ---
async function generateAndEmbedImage(rawImagePrompt, baseFilename) {
    if (!rawImagePrompt || typeof rawImagePrompt !== 'string' || rawImagePrompt.trim().length === 0) {
        console.warn("Skipping image generation: Received empty or invalid prompt.");
        return { success: false, error: "No valid prompt provided", markdown: "<!-- Image generation skipped: No valid prompt provided -->" };
    }

    const initialTrimmedPrompt = rawImagePrompt.trim();
    let extractedPrompt = initialTrimmedPrompt; // **Fallback: Start by assuming the whole trimmed content is the prompt**

    const lines = initialTrimmedPrompt.split(/\r?\n/); // Split by newlines
    let promptStartIndex = -1; // Index of the line *after* the marker line

    // Regex to find a line containing "Image Prompt" (case-insensitive)
    const markerRegex = /image prompt/i;

    for (let i = 0; i < lines.length; i++) {
        if (markerRegex.test(lines[i])) {
            promptStartIndex = i + 1; // The prompt starts on the line *after* this one
            console.log(`Found line containing "Image Prompt" at index ${i}: "${lines[i].trim()}"`);
            break; // Stop searching after finding the first marker line
        }
    }

    if (promptStartIndex !== -1 && promptStartIndex < lines.length) {
        // **Case 1: Marker found AND there is content after it**
        extractedPrompt = lines.slice(promptStartIndex).join('\n').trim();
        console.log(`Extracted content after marker. Snippet: "${extractedPrompt.substring(0, 150)}..."`);

    } else if (promptStartIndex === -1) {
        // **Case 2: Marker NOT found**
        // `extractedPrompt` is already set to `initialTrimmedPrompt` (the whole content).
        console.log(`Line containing "Image Prompt" not found. Assuming entire content is the prompt. Snippet: "${extractedPrompt.substring(0, 150)}..."`);
         // No change needed for extractedPrompt here
    } else { // This case is promptStartIndex === lines.length
        // **Case 3: Marker found, but it was the very last line**
         console.warn(`Line containing "Image Prompt" was the last line. No prompt content found after it for file ${currentInputFile}. Skipping image generation.`);
         return { success: false, error: `Line containing "Image Prompt" found but no content followed.`, markdown: "<!-- Image generation skipped: Image prompt marker found but content empty -->" };
    }

    // Optional: Clean up common leading markdown list markers IF they are at the very start
    // This cleanup should happen *after* deciding which content to extract
    extractedPrompt = extractedPrompt.replace(/^\s*[-\*]+\s*/, '').trim(); // Removes leading whitespace, -, *, and following whitespace


    // Now `extractedPrompt` holds either the content after the marker (if found)
    // OR the entire initial trimmed content (if marker not found).

    // 1. Truncate the prompt if it's too long
    let finalImagePrompt = extractedPrompt; // Rename for clarity in truncation block

    if (finalImagePrompt.length > MAX_IMAGE_PROMPT_LENGTH) {
        console.warn(`Extracted image prompt exceeds ${MAX_IMAGE_PROMPT_LENGTH} characters (length: ${finalImagePrompt.length}). Truncating.`);
        let truncatedPrompt = finalImagePrompt.substring(0, MAX_IMAGE_PROMPT_LENGTH);

        // Optional: Truncate at the last word boundary near the end for better prompts
        const lastSpaceIndex = truncatedPrompt.lastIndexOf(' ');
        if (lastSpaceIndex !== -1 && lastSpaceIndex > MAX_IMAGE_PROMPT_LENGTH - 100) { // Look back 100 chars for a space
             truncatedPrompt = truncatedPrompt.substring(0, lastSpaceIndex);
             console.log(`Truncated at word boundary (new length: ${truncatedPrompt.length}).`);
        }

        finalImagePrompt = truncatedPrompt.trim(); // Final trim after truncation
    }

     // Final check for empty prompt after cleaning/truncation
    if (finalImagePrompt.length === 0) {
        console.warn("Skipping image generation: Prompt became empty after extraction/cleaning/truncation.");
        return { success: false, error: "Prompt empty after processing", markdown: "<!-- Image generation skipped: Prompt empty after processing -->" };
    }


    console.log(`Generating image with prompt (final length ${finalImagePrompt.length}): "${finalImagePrompt.substring(0, 150)}..."`); // Log length and snippet

    try {
        const imageResponse = await openai.images.generate({
            model: IMAGE_GEN_MODEL,
            prompt: finalImagePrompt, // Use the cleaned and truncated prompt
            n: 1,
        });

        if (!imageResponse.data || !imageResponse.data[0] || !imageResponse.data[0].url) {
            throw new Error("Image generation API response did not contain a valid image URL.");
        }

        const imageUrl = imageResponse.data[0].url;
        let imageExt = '.png'; // Default
        try {
            const parsedUrl = new URL(imageUrl);
            const pathname = parsedUrl.pathname;
            const ext = path.extname(pathname);
            if (ext && ext.length > 1) { // Ensure ext is not just "."
                imageExt = ext.toLowerCase(); // Use lowercase extension
            } else {
                 console.warn(`Could not determine image extension from URL path: ${imageUrl}. Using default .png`);
            }
        } catch (urlError) {
            console.warn(`Could not parse generated image URL (${imageUrl}) for extension:`, urlError.message);
        }

        // Generate a more robust image name including prompt hash snippet
         const promptHashSnippet = generatePromptHash(finalImagePrompt, 6); // Get a shorter hash for filename
        const imageName = `grok-${Date.now()}-${baseFilename}-${promptHashSnippet}${imageExt}`; // Include filename part and hash
        const imagePath = path.join(OUTPUT_IMAGES_DIR, imageName);
        const relativeImagePathForMarkdown = `/${path.basename(OUTPUT_IMAGES_DIR)}/${imageName}`.replace(/\\/g, '/');

        console.log(`Downloading generated image from ${imageUrl} to ${imagePath}...`);
        const imageDownloadResponse = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 60000 }); // Increased timeout
        await fs.writeFile(imagePath, Buffer.from(imageDownloadResponse.data));

        console.log(`Image successfully saved as ${imagePath}`);
        return { success: true, markdown: `\n\n![Generated Image](${relativeImagePathForMarkdown})\n\n`, finalPromptUsed: finalImagePrompt };

    } catch (error) {
        console.error(`Error generating or saving image for prompt snippet "${finalImagePrompt.substring(0, 150)}...":`, error.message || error);
        if (error.response?.data) {
            console.error("API Error Details:", JSON.stringify(error.response.data, null, 2));
        } else if (axios.isAxiosError(error)) {
            console.error("Axios Error Details:", { code: error.code, message: error.message, url: error.config?.url, status: error.response?.status });
        }
        return { success: false, error: error.message, markdown: '\n\n<!-- Image Generation Failed -->\n\n' };
    }
}

// Keep generatePromptHash function

function generatePromptHash(promptText, length = 8) {
    let hash = 0;
     if (!promptText || typeof promptText !== 'string' || promptText.length === 0) return 'noPrompt';
    for (let i = 0; i < promptText.length; i++) {
        const char = promptText.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0; // Convert to 32bit integer
    }
     // Make it positive and take substring
     return Math.abs(hash).toString(16).padStart(8, '0').substring(0, length); // Pad to ensure length consistency
}


// --- Core Processing Logic ---
// ... (keep processOriginalImage function) ...
async function processOriginalImage(imageUrl) {
    if (!imageUrl || typeof imageUrl !== 'string') return "";

    console.log(`Processing original image with vision model: ${imageUrl}`);
    try {
        const completion = await openai.chat.completions.create({
            model: VISION_MODEL,
            temperature: 0.2,
            max_tokens: 250,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
                        { type: "text", text: "Compose a descriptive Shakespearean Sonnet inspired by this image." },
                    ],
                },
            ],
        });

        const sonnet = completion.choices[0]?.message?.content || "";
        if (!sonnet) {
             console.warn("Vision model returned empty content for image:", imageUrl)
             return ""
        }
        const encodedImageUrl = encodeURI(imageUrl); // Basic encoding for URL in markdown
        return `### Sonnet for Original Image\n\n![](${encodedImageUrl})\n\n${sonnet.trim()}\n\n`;
    } catch (error) {
        console.error(`Error processing original image (${imageUrl}) with vision model:`, error.message || error);
         if (error.response?.data) {
             console.error("API Error Details:", JSON.stringify(error.response.data, null, 2));
         }
        return "<!-- Vision processing failed for original image -->\n\n";
    }
}

// --- Utility Functions ---
// CORRECTED escapeHtml function (Fixed syntax and entities)
function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') {
       return unsafe === null || unsafe === undefined ? '' : String(unsafe);
    }
    // Correctly escape HTML characters for display within a code block
    // Order matters: escape & first!
    return unsafe
         .replace(/&/g, "&")
         .replace(/</g, "<")
         .replace(/>/g, ">")
         .replace(/"/g, "\"")
         .replace(/'/g, "'")
}

// --- processSingleFile (REVISED Image Gen Call and HTML Generation) ---
async function processSingleFile(inputFile, selectedPrompt) {
    currentInputFile = inputFile;
    currentInputPath = path.join(INPUT_DATA_DIR, inputFile);
    const baseFilename = path.basename(inputFile, '.json');

    console.log(`\n--- Processing File: ${inputFile} with Prompt: ${selectedPrompt.name} ---`);

    try {
        // 1. Read and Parse Input JSON
        const rawJsonContent = await fs.readFile(currentInputPath, 'utf8');
        let inputData = JSON.parse(rawJsonContent);

        // 2. Transform if necessary
        if (inputData.hasOwnProperty('content') && !inputData.hasOwnProperty('ogResult')) {
            console.log(`Transforming simpler input structure for ${inputFile}...`);
            inputData = transformInputJson(inputData);
        } else if (!inputData.hasOwnProperty('ogResult')) {
            console.warn(`Skipping ${inputFile}: Invalid format (missing ogResult).`);
            return;
        }

        // Ensure essential fields exist (with nullish coalescing for safety)
        inputData.ogResult = inputData.ogResult ?? {};
        inputData.ogResult.ogTitle = inputData.ogResult.ogTitle ?? inputData.name ?? 'Untitled';
        inputData.ogResult.ogUrl = inputData.ogResult.ogUrl ?? inputData.url ?? '';
        inputData.ogHTML = inputData.ogHTML ?? '';
        inputData.ogResult.ogImage = inputData.ogResult.ogImage ?? [];
        inputData.youtube = inputData.youtube ?? {}; // Keep youtube handling

        // 3. Create JSON Copy
        const jsonCopyFilename = inputFile;
        const jsonCopyPath = path.join(JSON_COPY_DIR, jsonCopyFilename);
        await fs.writeFile(jsonCopyPath, JSON.stringify(inputData, null, 2));
        console.log(`Copied processed JSON structure to ${jsonCopyPath}`);

        // 4. Extract Original Image URL
        let originalImageUrl = null;
        if (Array.isArray(inputData.ogResult.ogImage) && inputData.ogResult.ogImage.length > 0) {
            // Handle both {url: ...} and plain string formats
            const firstImage = inputData.ogResult.ogImage[0];
            originalImageUrl = typeof firstImage === 'object' && firstImage !== null ? firstImage.url : (typeof firstImage === 'string' ? firstImage : null);
        }

        // 5. Aggregate Text Content & Clean
        let fullTextContent = [
            inputData.ogResult?.ogUrl,
            inputData.ogResult?.ogTitle,
            inputData.ogResult?.ogDescription,
            inputData.youtube?.subtitles // Include subtitles if they exist
        ].filter(Boolean).join('\n\n'); // Add more spacing

        // Handle JSON-LD Article Body (if present)
        if (inputData.ogResult?.jsonLD && Array.isArray(inputData.ogResult.jsonLD)) {
            const article = inputData.ogResult.jsonLD.find(item => item.articleBody && typeof item.articleBody === 'string');
            if (article?.articleBody) {
                // Note: Blockquotes are standard Markdown, no need for raw HTML unless specific styling needed.
                // Let's generate markdown blockquote instead of raw HTML
                fullTextContent += `\n\n> Article Content (JSON-LD) from [${escapeHtml(inputData.ogResult?.ogUrl ?? '')}](${inputData.ogResult?.ogUrl ?? ''}):\n> ${article.articleBody.split('\n').join('\n> ')}`; // Split and add "> " to each line
            }
        }

         // Clean HTML content - improved regex and entity handling
        const cleanedHtmlContent = (inputData.ogHTML ?? '')
            .replace(/<style[^>]*>.*?<\/style>/gis, ' ') // Remove style blocks
            .replace(/<script[^>]*>.*?<\/script>/gis, ' ') // Remove script blocks
            .replace(/<!--.*?-->/gs, ' ') // Remove HTML comments
            .replace(/<nav[^>]*>.*?<\/nav>/gis, ' ') // Remove nav sections
            .replace(/<header[^>]*>.*?<\/header>/gis, ' ') // Remove header sections
            .replace(/<footer[^>]*>.*?<\/footer>/gis, ' ') // Remove footer sections
            .replace(/<aside[^>]*>.*?<\/aside>/gis, ' ') // Remove aside sections
            // No need to decode common HTML entities here if stripping tags
            .replace(/<[^>]+>/g, ' ') // Strip remaining tags
            .replace(/\s{2,}/g, ' ') // Collapse multiple spaces to one
            .trim();

        if (cleanedHtmlContent) {
             // Append as regular text or perhaps a code block if it's structured HTML content?
             // Let's append as regular text for now, escaping only for HTML output *if* we were putting it in HTML.
             // Since we are building Markdown, let's just add the cleaned text directly.
            fullTextContent += `\n\nPage Content:\n${cleanedHtmlContent}`; // Cleaned text is fine directly in Markdown source
        }
        fullTextContent = fullTextContent.trim();


        if (fullTextContent.length === 0) {
            console.warn(`Skipping ${inputFile}: No text content found after cleaning.`);
            return;
        }

        // 6. Process Original Image (Concurrent)
        const imageSonnetPromise = processOriginalImage(originalImageUrl);

        // 7. Chunk Text Content
        const textChunks = [];
        // Ensure minimum chunk size to avoid sending tiny requests
        const MIN_CHUNK_SIZE = 200; // Characters
        if (fullTextContent.length < MIN_CHUNK_SIZE) {
             if (fullTextContent.length > 0) {
                 textChunks.push(fullTextContent); // Add if not empty
             }
        } else if (fullTextContent.length <= MAX_CHUNK_SIZE_CHARS) {
            textChunks.push(fullTextContent);
        } else {
            console.log(`Text content is long (${fullTextContent.length} chars), chunking...`);
            let startIndex = 0;
            while (startIndex < fullTextContent.length) {
                 let endIndex = Math.min(startIndex + MAX_CHUNK_SIZE_CHARS, fullTextContent.length);
                 let chunk = fullTextContent.substring(startIndex, endIndex);

                 // If not the last chunk and the next char is not the end of string, try to find a break point
                 if (endIndex < fullTextContent.length) {
                     let breakPoint = -1;

                     // Look for paragraph breaks (\n\n) in the last 20% of the chunk
                     let searchStart = Math.max(startIndex, endIndex - Math.floor(MAX_CHUNK_SIZE_CHARS * 0.2));
                     breakPoint = fullTextContent.lastIndexOf('\n\n', endIndex);
                     if (breakPoint <= startIndex) breakPoint = -1; // Ignore breaks before the current start

                     // If no paragraph break or too early, look for sentence breaks (. ! ?)
                     if (breakPoint === -1 || breakPoint < searchStart) {
                        // Search within the chunk substring for sentence end followed by space/newline
                        const sentenceBreakMatch = chunk.substring(searchStart - startIndex).match(/[.!?]\s/);
                         if (sentenceBreakMatch) {
                              breakPoint = searchStart + sentenceBreakMatch.index + sentenceBreakMatch[0].length -1; // Position in fullTextContent
                         }
                     }

                      // If no sentence break, look for simple newline breaks
                     if (breakPoint === -1 || breakPoint < searchStart) {
                         breakPoint = fullTextContent.lastIndexOf('\n', endIndex);
                         if (breakPoint <= startIndex) breakPoint = -1;
                     }

                     // If still no good break point, look for space breaks
                     if (breakPoint === -1 || breakPoint < searchStart) {
                         breakPoint = fullTextContent.lastIndexOf(' ', endIndex);
                         if (breakPoint <= startIndex) breakPoint = -1;
                     }

                     // If a reasonable break point was found, adjust endIndex
                     if (breakPoint !== -1 && breakPoint > startIndex) {
                         endIndex = breakPoint;
                     }
                     // If no good break point found, endIndex remains Math.min(startIndex + MAX_CHUNK_SIZE_CHARS, fullTextContent.length)
                     chunk = fullTextContent.substring(startIndex, endIndex); // Update chunk based on new endIndex
                 }

                const trimmedChunk = chunk.trim();
                if (trimmedChunk.length >= MIN_CHUNK_SIZE || (startIndex + chunk.length >= fullTextContent.length && trimmedChunk.length > 0)) {
                     // Add the chunk if it meets min size, OR if it's the last piece and non-empty
                    textChunks.push(trimmedChunk);
                } else if (trimmedChunk.length > 0) {
                     // If too small but not the last piece, try to append to previous? Or just skip?
                     // Skipping small trailing pieces might be acceptable depending on prompt tolerance.
                     console.warn(`Skipping small chunk (${trimmedChunk.length} chars) from index ${startIndex}`);
                 }

                 startIndex = endIndex; // Start the next chunk from the end of the current one
                 // Skip any whitespace/breaks after the break point
                 while (startIndex < fullTextContent.length && /\s/.test(fullTextContent[startIndex])) {
                      startIndex++;
                 }
            }
            console.log(`Split into ${textChunks.length} usable chunks.`);
            if (textChunks.length === 0) {
                console.warn(`Skipping ${inputFile}: Chunking resulted in no usable text content.`);
                return;
            }
        }


        // 8. Prepare Text Chunk API Calls
const textApiPromises = textChunks.map((chunk, index) => {
    console.log(`Preparing API call for text chunk ${index + 1}/${textChunks.length}`);
    const userMessageContent = selectedPrompt.chat.replace('[[chunk]]', textChunks[index]);
    return openai.chat.completions.create({
        model: TEXT_MODEL,
        stream: false,
        temperature: 1.0,
        messages: [
            { role: "system", content: selectedPrompt.system },
            { role: "user", content: userMessageContent },
        ],
        search_parameters: {
            mode: "on", // As previously modified
            max_search_results: 10
        },
        sources: [
            { type: "web" },
            { type: "x" },
            { type: "news" },
            { type: "rss" } // Added experimentally
        ]
    }).catch(err => {
        console.error(`Error processing text chunk ${index + 1} for ${inputFile}:`, err.message || err);
        return {
            error: true,
            chunkIndex: index + 1,
            message: err.message,
            status: err.response?.status,
            data: err.response?.data
        };
    });
});

        // 9. Execute API Calls Concurrently
        console.log("Sending API requests...");
        const [imageSonnetResult, ...textApiResults] = await Promise.all([
            imageSonnetPromise,
            ...textApiPromises
        ]);

// 10. Process Text API Responses
let combinedVerseOutput = "";
let toc = "## Table of Contents\n";
const extractedImagePrompts = [];
const extractedVideoPrompts = [];

textApiResults.forEach((res, index) => {
    const chunkNumber = index + 1;
    if (!res || res.error) {
        toc += `- ~~Verse ${chunkNumber} (Error)~~ \n`;
        combinedVerseOutput += `<h3 id="verse-${chunkNumber}">Verse ${chunkNumber}</h3>\n<p><em>Error: ${escapeHtml(res?.message || 'Unknown')}</em></p>\n\n`;
        return;
    }
    const messageContent = res.choices?.[0]?.message?.content?.trim() ?? "";
    if (!messageContent) {
        toc += `- [Verse ${chunkNumber}](#verse-${chunkNumber}) (Empty)\n`;
        combinedVerseOutput += `<h3 id="verse-${chunkNumber}">Verse ${chunkNumber}</h3>\n<p><em>Empty response</em></p>\n\n`;
        return;
    }
    const sections = { verse: '', image: '', video: '' };

    // Use regex to match headers and capture content
    const imagePromptMatch = messageContent.match(/### Image Prompt\s*[\r\n]+([\s\S]*?)(?=###|$)/i);
    const videoPromptMatch = messageContent.match(/### Video Prompt\s*[\r\n]+([\s\S]*?)(?=###|$)/i);

    if (imagePromptMatch && imagePromptMatch[1]) {
        sections.image = imagePromptMatch[1].trim();
        extractedImagePrompts.push(sections.image);
        toc += `  - [Image Prompt ${chunkNumber}](#image-prompt-${chunkNumber})\n`;
    }
    if (videoPromptMatch && videoPromptMatch[1]) {
        sections.video = videoPromptMatch[1].trim();
        extractedVideoPrompts.push(sections.video);
        toc += `  - [Video Prompt ${chunkNumber}](#video-prompt-${chunkNumber})\n`;
    }

    // Extract verse as everything before the first prompt header or the entire content
    const firstPromptIndex = Math.min(
        imagePromptMatch ? imagePromptMatch.index : Infinity,
        videoPromptMatch ? videoPromptMatch.index : Infinity
    );
    sections.verse = (firstPromptIndex === Infinity
        ? messageContent
        : messageContent.substring(0, firstPromptIndex)).trim();

    toc += `- [Verse ${chunkNumber}](#verse-${chunkNumber})\n`;
    combinedVerseOutput += `<h3 id="verse-${chunkNumber}">Verse ${chunkNumber}</h3>\n${escapeHtml(sections.verse)}\n\n`;
    if (sections.image) {
        combinedVerseOutput += `<h3 id="image-prompt-${chunkNumber}">Image Prompt ${chunkNumber}</h3>\n<pre><code class="language-text">${escapeHtml(sections.image)}</code></pre>\n\n`;
    }
    if (sections.video) {
        combinedVerseOutput += `<h3 id="video-prompt-${chunkNumber}">Video Prompt ${chunkNumber}</h3>\n<pre><code class="language-text">${escapeHtml(sections.video)}</code></pre>\n\n`;
    }
});


        // 11. Generate Image and Figure Block
        let figureWithGeneratedImage = "";
        let finalPromptUsedForImage = null;

        if (extractedImagePrompts.length > 0) {
            const randomIndex = Math.floor(Math.random() * extractedImagePrompts.length);
            const rawSelectedPrompt = extractedImagePrompts[randomIndex];
            // Pass the raw extracted prompt to the revised generateAndEmbedImage function
            const imageGenResult = await generateAndEmbedImage(rawSelectedPrompt, baseFilename);

             finalPromptUsedForImage = imageGenResult.finalPromptUsed; // Get the final (potentially truncated) prompt

            if (imageGenResult.success && finalPromptUsedForImage) {
                // Construct the figure block with the *actual* prompt used
                 figureWithGeneratedImage = `
${imageGenResult.markdown.trim()}
  <p><em>Image generated using the prompt (potentially truncated):</em></p>
  <pre><code class="language-text">${escapeHtml(finalPromptUsedForImage)}</code></pre>
`; // Use language-text for the prompt display
            } else {
                // Handle image generation failure - include placeholder/error
                figureWithGeneratedImage = imageGenResult.markdown; // Contains the error comment
                 if(imageGenResult.error){
                     console.error(`Failed to generate image: ${imageGenResult.error}`);
                 }
                 // Include the intended prompt if available, even on failure
                 if (rawSelectedPrompt) {
                    figureWithGeneratedImage += `\n<!-- Attempted using prompt snippet: ${escapeHtml(rawSelectedPrompt.substring(0, 200))}... -->`;
                 }
            }

        } else {
            console.log("No image prompts were extracted. Skipping image generation.");
            figureWithGeneratedImage = "<!-- No image prompts found to generate an image -->";
        }


        // 12. Construct Final Markdown Output
        const promptHash = generatePromptHash(selectedPrompt.system + selectedPrompt.chat);
        const safeTitlePart = (inputData.ogResult.ogTitle || baseFilename)
            .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Remove accents
            .replace(/[^\p{L}\p{N}_ -]/gu, '') // Allow letters, numbers, underscore, hyphen, space
            .replace(/\s+/g, '_')
            .substring(0, 50);
        const outputFilename = `${safeTitlePart}-${TEXT_MODEL.replace(/[^a-zA-Z0-9-]/g, '')}-${promptHash}.md`;
        const outputPath = path.join(OUTPUT_POSTS_DIR, outputFilename);
        // Use relative paths for linking within the site structure
        const relativeJsonPath = `/${path.basename(JSON_COPY_DIR)}/${jsonCopyFilename}`.replace(/\\/g, '/'); // For web access

        // Prepare front matter values, ensuring strings with special chars are quoted correctly for YAML
        const fmTitle = (inputData.ogResult.ogTitle || 'Untitled').replace(/"/g, '\\"'); // Escape internal quotes for YAML
        const fmAuthor = `Grok (${selectedPrompt.poet ? selectedPrompt.poet + ' / ' : ''}${selectedPrompt.style ? selectedPrompt.style : 'Default Style'})`;


        const markdownOutput = `---
title: "${fmTitle} - ${selectedPrompt.name}"
author: "${fmAuthor}"
date: ${new Date().toISOString()}
tags: [${TEXT_MODEL}, ${selectedPrompt.name.replace(/\s+/g, '-')}, ${selectedPrompt.style ? selectedPrompt.style.replace(/\s+/g, '-') : ''}, ${selectedPrompt.poet ? selectedPrompt.poet.replace(/\s+/g, '-') : ''}]
---

Source: [${escapeHtml(inputData.ogResult.ogTitle)}](${inputData.ogResult.ogUrl}) ([Input Data](/js/${relativeJsonPath}))

${toc}
<hr>

${combinedVerseOutput}

<hr>
${imageSonnetResult} <!-- Sonnet about original image -->

${figureWithGeneratedImage} <!-- Newly generated image with caption -->

<hr>
### Generation Details
<details>
  <summary>Click to view Models and Prompt</summary>
  <p><strong>Text Model:</strong> ${TEXT_MODEL}<br>
  <strong>Vision Model:</strong> ${VISION_MODEL}<br>
  <strong>Image Gen Model:</strong> ${IMAGE_GEN_MODEL}</p>
  <p><strong>Prompt Used (Name: ${selectedPrompt.name}):</strong></p>
  <strong>System:</strong>
  <pre><code class="language-text">${escapeHtml(selectedPrompt.system)}</code></pre>
  <strong>Chat Template (with [[chunk]] placeholder):</strong>
  <pre><code class="language-text">${escapeHtml(selectedPrompt.chat)}</code></pre>
</details>

<hr>

<!-- NOTE: The following script block is included here for context, but should ideally -->
<!-- be moved to your Static Site Generator's main layout/template file(s) -->
<!-- along with the Highlight.js CSS and JS includes. -->
<script>
 // Helper function for toggling original text visibility
 // This function should live in your site's global script file.
 function showOriginalText(number) {
    const textDisplay = document.getElementById(\`textDisplay\${number}\`);
    // Use a more robust selector for the button if needed, or rely on the onclick
    const button = document.querySelector(\`button[onclick="showOriginalText(\${number})"]\`);
    const codeElement = textDisplay?.querySelector('code'); // Use optional chaining

    if (!textDisplay || !button || !codeElement) {
        console.error(\`Could not find elements for chunk \${number}\`);
        return;
    }

    const isHidden = textDisplay.style.display === 'none';
    textDisplay.style.display = isHidden ? 'block' : 'none';
    button.textContent = isHidden ? \`Hide Original Text For Chunk \${number}\` : \`Show Original Text For Chunk \${number}\`;

    // Highlight only when shown for the first time IF Highlight.js is available
    // This assumes Highlight.js is loaded globally in your site template.
    if (isHidden && typeof hljs !== 'undefined' && !codeElement.hasAttribute('data-highlighted')) {
         try {
            hljs.highlightElement(codeElement);
            codeElement.setAttribute('data-highlighted', 'yes');
            console.log(\`Highlighted code block for chunk \${number}.\`);
         } catch(e) { console.error('Error highlighting original text chunk:', e); }
    } else if (isHidden && typeof hljs === 'undefined') {
        console.warn("Highlight.js not available to highlight original text chunk.");
    }
 }

 // NOTE: The call to initializeHighlighting and the DOMContentLoaded listener
 // should also be in your site's global script file, not embedded here.
 // They are commented out below to indicate this.
 // document.addEventListener('DOMContentLoaded', initializeHighlighting); // Remove from here
 // initializeHighlighting(); // Remove from here
</script>
`;
         // REMOVE THE HIGHLIGHT.JS LINK AND SCRIPT TAGS from the markdown output
         // This should be handled by your SSG's layout/template.
         // Removing:
         // <link rel="stylesheet" ...>
         // <script src="...highlight.min.js"></script>
         // <script src="...languages/json.min.js"></script>
         // <script src="...languages/plaintext.min.js"></script>
         // <script src="...languages/javascript.min.js"></script>
         // <script src="...languages/bash.min.js"></script>
         // <script> ... hljsInitialized ... </script> (Your initialization script)
         // <script> ... showOriginalText ... </script> (Your show/hide function - Keep a placeholder comment or simpler script, but the function itself should be global)

        // Let's re-construct the markdownOutput string, removing the unwanted script/link block
        const cleanMarkdownOutput = `---
title: "${fmTitle} - ${selectedPrompt.name}"
author: "${fmAuthor}"
date: ${new Date().toISOString()}
tags: [${TEXT_MODEL}, ${selectedPrompt.name.replace(/\s+/g, '-')}, ${selectedPrompt.style ? selectedPrompt.style.replace(/\s+/g, '-') : ''}, ${selectedPrompt.poet ? selectedPrompt.poet.replace(/\s+/g, '-') : ''}]
---

Source: [${escapeHtml(inputData.ogResult.ogTitle)}](${inputData.ogResult.ogUrl}) ([Input Data](/js/${relativeJsonPath}))

${toc}
<hr>

${combinedVerseOutput}

<hr>
${imageSonnetResult} <!-- Sonnet about original image -->

${figureWithGeneratedImage} <!-- Newly generated image with caption -->

<hr>
### Generation Details
<details>
  <summary>Click to view Models and Prompt</summary>
  <p><strong>Text Model:</strong> ${TEXT_MODEL}<br>
  <strong>Vision Model:</strong> ${VISION_MODEL}<br>
  <strong>Image Gen Model:</strong> ${IMAGE_GEN_MODEL}</p>
  <p><strong>Prompt Used (Name: ${selectedPrompt.name}):</strong></p>
  <strong>System:</strong>
  <pre><code class="language-text">${escapeHtml(selectedPrompt.system)}</code></pre>
  <strong>Chat Template (with [[chunk]] placeholder):</strong>
  <pre><code class="language-text">${escapeHtml(selectedPrompt.chat)}</code></pre>
</details>

<hr>

<!--
NOTE: Highlight.js CSS, JS, language files, and any site-wide initialization
scripts (like one that calls hljs.highlightAll() or hljs.highlightElement())
should be included in your Static Site Generator's theme layout, NOT embedded
in the individual Markdown post files like this script used to do.

The 'showOriginalText' function needed for the buttons below must also be
included in a global script file by your SSG's template.
-->
<script>
 // Minimal script included just for the button functionality if showOriginalText
 // is provided globally by the theme.
 function showOriginalText(number) {
    const textDisplay = document.getElementById(\`textDisplay\${number}\`);
    const button = document.querySelector(\`button[onclick="showOriginalText(\${number})"]\`);
    const codeElement = textDisplay?.querySelector('code');

    if (!textDisplay || !button || !codeElement) {
        console.error(\`Could not find elements for chunk \${number}\`);
        return;
    }

    const isHidden = textDisplay.style.display === 'none';
    textDisplay.style.display = isHidden ? 'block' : 'none';
    button.textContent = isHidden ? \`Hide Original Text For Chunk \${number}\` : \`Show Original Text For Chunk \${number}\`;

    // Attempt to highlight if Highlight.js is globally available and not already done
    if (isHidden && typeof hljs !== 'undefined' && !codeElement.hasAttribute('data-highlighted')) {
        try {
            hljs.highlightElement(codeElement);
            codeElement.setAttribute('data-highlighted', 'yes');
            console.log(\`Highlighted code block for chunk \${number}.\`);
        } catch(e) {
             console.error('Error highlighting original text chunk:', e);
             // Fallback: Add hljs class even if highlighting fails to prevent re-attempts
             codeElement.classList.add('hljs');
        }
    } else if (isHidden && typeof hljs === 'undefined') {
        console.warn("Highlight.js not available to highlight original text chunk.");
        // Add hljs class so this block is skipped in future manual checks
        codeElement.classList.add('hljs');
    }
 }
 // Note: No DOMContentLoaded listener or hljs.init calls here.
 // These must be in your SSG's global layout script.
</script>
`;


        // 13. Write Output File
        // Use the cleanMarkdownOutput
        await fs.writeFile(outputPath, cleanMarkdownOutput);
        console.log(`Successfully generated Markdown: ${outputPath}`);

    } catch (error) {
        console.error(`\n--- ERROR processing file ${currentInputFile} ---`);
        console.error(error.stack || error);
    } finally {
        currentInputFile = '';
        currentInputPath = '';
    }
}


// --- Main Execution ---
async function main() {
    console.log("Starting Grok processing script...");
    try {
        // Ensure Dirs
        await fs.mkdir(OUTPUT_POSTS_DIR, { recursive: true });
        await fs.mkdir(OUTPUT_IMAGES_DIR, { recursive: true });
        await fs.mkdir(JSON_COPY_DIR, { recursive: true });
        console.log(`Ensured directories exist: ${OUTPUT_POSTS_DIR}, ${OUTPUT_IMAGES_DIR}, ${JSON_COPY_DIR}`);

        // Load Prompts FIRST
        await loadAndPreparePrompts();
        if (availablePrompts.length === 0) {
             console.error("FATAL: No valid prompts loaded. Exiting.");
             process.exit(1);
        }

        // Select Prompt & Update State
        const promptIndexToUse = getNextPromptIndexSync(); // Now uses availablePrompts.length safely
        const selectedPrompt = availablePrompts[promptIndexToUse];
        console.log(`Selected prompt for this run: ${selectedPrompt.name} (Index: ${promptIndexToUse})`);
        setPromptIndexSync(promptIndexToUse);

        // Find Input Files
        let files;
        try {
             files = await fs.readdir(INPUT_DATA_DIR);
        } catch (err) {
             if (err.code === 'ENOENT') {
                 console.error(`FATAL: Input data directory not found: ${INPUT_DATA_DIR}`);
                 process.exit(1);
             } else { throw err; } // Rethrow other errors
        }

        const jsonFiles = files.filter(file => path.extname(file).toLowerCase() === '.json' && !file.startsWith('.')); // Ignore hidden files
        if (jsonFiles.length === 0) {
            console.log(`No JSON files found in ${INPUT_DATA_DIR}. Exiting.`);
            return;
        }
        console.log(`Found ${jsonFiles.length} JSON files to process.`);

        // Process Files Sequentially
        for (const file of jsonFiles) {
            await processSingleFile(file, selectedPrompt);
        }

        console.log("\n--- Script finished ---");

    } catch (error) {
        console.error("\n--- FATAL ERROR during script execution ---");
        console.error(error.stack || error);
        process.exit(1);
    }
}

main();

// --- END OF REVISED FILE groem11.js ---
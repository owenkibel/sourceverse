// --- START OF NEW FILE goem6.js ---

const path = require('path');
const fs = require('fs/promises');
const fss = require('fs'); // Keep sync version for simple state file initially
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const axios = require('axios'); // Keep for downloading original images

// --- Configuration ---
const INPUT_DATA_DIR = 'ogs_data'; // Directory containing input JSON files
const JSON_COPY_DIR = 'json'; // Subfolder for copies of processed JSONs
const PROMPTS_DIR = path.join(__dirname, 'prompts'); // Directory for prompt templates
const OUTPUT_POSTS_DIR = 'posts'; // Directory for generated Markdown files
const OUTPUT_IMAGES_DIR = 'images'; // Directory for generated images
const PROMPT_STATE_FILE = path.join(__dirname, 'gemini.txt'); // File to store the next prompt index (keep consistent for this model)

// Chunk Size Parameters (Aligning with groem7.js for consistency, though Gemini might handle more)
const MAX_CHUNK_TOKEN_ESTIMATE = 8000; // Less critical for Gemini Flash, but provides control
const AVG_CHARS_PER_TOKEN = 4; // Rough estimate
const MAX_CHUNK_SIZE_CHARS = MAX_CHUNK_TOKEN_ESTIMATE * AVG_CHARS_PER_TOKEN;

// Initialize Google Generative AI client
const apiKey = process.env.API_KEY; // Assuming Gemini API key is in API_KEY env var
if (!apiKey) {
    console.error("FATAL: API_KEY environment variable for Google AI is not set.");
    process.exit(1);
}
const genAI = new GoogleGenerativeAI(apiKey);

// Specify Models (Using names from goem5.js)
const TEXT_MODEL_NAME = "gemini-2.5-flash-preview-04-17"; // Use a generally available and capable model
// NOTE: As of late 2024, specific "image generation" model names might change.
// Check Google AI documentation for current recommendations if this fails.
// Let's try using the standard model for image generation too, as capabilities evolve.
const IMAGE_GEN_MODEL_NAME = "gemini-2.0-flash-exp-image-generation"; // Check if this model supports image generation tasks via prompts

const VISION_MODEL_NAME = "gemini-2.5-flash-preview-04-17"; // Can often handle vision tasks

const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// Get Models (Add error handling)
let textModel, imageGenModel, visionModel;
try {
    textModel = genAI.getGenerativeModel({ model: TEXT_MODEL_NAME });
    // Check Gemini docs: Image generation might need specific setup or a different model endpoint
    // Assuming the text model can handle image generation prompts for now. Adjust if needed.

    imageGenModel = genAI.getGenerativeModel({
        model: IMAGE_GEN_MODEL_NAME,
        generationConfig: {
            responseModalities: ['Text', 'Image']
        },
       
    });

    visionModel = genAI.getGenerativeModel({ model: VISION_MODEL_NAME, safetySettings });
    console.log(`Models initialized: Text/Vision/ImageGen (${TEXT_MODEL_NAME})`);
} catch (modelError) {
    console.error("FATAL: Error initializing Google AI models:", modelError.message);
    process.exit(1);
}


// --- Globals ---
let currentInputFile = '';
let currentInputPath = '';

// --- Prompt Management ---
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

            // Ensure 'system' and 'chat' properties exist (adjust if Gemini uses different terms)
            if (!promptData.system || !promptData.chat) {
                console.warn(`Skipping prompt file ${file}: Missing 'system' or 'chat' property.`);
                continue;
            }

            let systemPrompt = promptData.system; // Gemini might call this context or initial instruction
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
                system: systemPrompt, // Keep system instruction separate
                chat: chatPrompt,     // Keep chat template separate
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
        // Ensure availablePrompts is populated before using its length
        if (availablePrompts.length === 0) {
            console.warn("availablePrompts is empty when calling getNextPromptIndexSync. Returning 0.");
            return 0;
        }
        const data = fss.readFileSync(PROMPT_STATE_FILE, 'utf-8');
        const index = parseInt(data.trim(), 10);
        if (isNaN(index) || index < 0) return 0;
        // Modulo operation should be safe even if index >= length
        return (index + 1) % availablePrompts.length;
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`Prompt state file (${PROMPT_STATE_FILE}) not found. Starting from index 0.`);
        } else {
            console.warn(`Warning reading prompt state file (${PROMPT_STATE_FILE}):`, error.message);
        }
        return 0; // Default to 0 on error or if file doesn't exist
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
                    if (nameParam.toLowerCase() === 'orig') return 10000; // Highest priority
                    if (nameParam.toLowerCase() === 'large') return 5000;
                    if (nameParam.toLowerCase() === 'medium') return 4000;
                    // Check for dimension format like '900x900'
                    const dimensionMatch = nameParam.match(/^(\d+)x(\d+)$/);
                    if (dimensionMatch) {
                        const width = parseInt(dimensionMatch[1], 10);
                        const height = parseInt(dimensionMatch[2], 10);
                        // Rank based on area or width (width is often sufficient)
                        return width * height; // Or just return width;
                    }
                    if (nameParam.toLowerCase() === 'small') return 1000;
                    if (nameParam.toLowerCase() === 'thumb') return 500;
                     if (nameParam.toLowerCase() === 'tiny') return 100;

                }
            } catch (e) {
                // Ignore URL parsing errors silently or log if needed
                // console.warn(`Could not parse URL for size rank: ${url}`, e.message);
            }
            // Check for _bigger, _normal patterns as lower priority fallbacks
             if (url.includes('_bigger.')) return 75;
             if (url.includes('_normal.')) return 50;
             if (url.includes('_mini.')) return 25;

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
                const isSpacer = /spacer|blank|1x1/.test(lowerCaseUrl); // Keep spacer check

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

            console.log('[Debug] Candidate Images Ranked:', JSON.stringify(candidateImages.slice(0, 5), null, 2)); // Log top 5 candidates

        // Select the best candidate (first one after sorting)
        if (candidateImages.length > 0) {
            const bestImage = candidateImages[0].url;
            console.log(`[Debug] Selected Best Image: ${bestImage} (Rank: ${candidateImages[0].rank})`);
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


// --- Image Generation ---
async function generateAndEmbedImage(imagePromptContent, baseFilename) {
    if (!imagePromptContent || typeof imagePromptContent !== 'string' || imagePromptContent.trim().length === 0) {
         console.warn("Skipping image generation: Received empty or invalid prompt.");
         return { success: false, error: "No valid prompt provided", markdown: "<!-- Image generation skipped: No valid prompt provided -->" };
    }
    console.log(`Generating image with prompt: "${imagePromptContent.substring(0, 100)}..."`);
    try {
        // Construct the prompt for Gemini's image generation
        // This might vary based on the model. Check Google AI docs.
        // Example: A simple text prompt might suffice.
        const generationPrompt = `Generate an image based on this description: ${imagePromptContent.trim()}`;

        // Make the API call using the imageGenModel
        const result = await imageGenModel.generateContent(generationPrompt);
        const response = result.response; // Use await result.response for direct access

        // Gemini might return image data differently. Look for parts with mimeType image/*.
        // Adjust this based on actual Gemini response structure for image generation.
        const imagePart = response?.candidates?.[0]?.content?.parts?.find(part => part.blob || part.fileData || part.inlineData?.mimeType?.startsWith('image/'));

        if (!imagePart) {
            // Check for safety blocks or other reasons for no image
            const blockReason = response?.promptFeedback?.blockReason;
            const safetyRatings = response?.candidates?.[0]?.safetyRatings;
            console.error("Image generation API response did not contain image data.", { blockReason, safetyRatings });
            throw new Error(`Image generation failed. Reason: ${blockReason || 'No image data found'}. Safety: ${JSON.stringify(safetyRatings)}`);
        }

        let imageDataBuffer;
        let imageExt = '.png'; // Default extension

        // Handle different ways Gemini might return image data
        if (imagePart.inlineData) {
            imageDataBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
            const mimeType = imagePart.inlineData.mimeType;
            if (mimeType === 'image/jpeg') imageExt = '.jpg';
            else if (mimeType === 'image/png') imageExt = '.png';
            else if (mimeType === 'image/webp') imageExt = '.webp';
            // Add other mime types if needed
            else imageExt = `.${mimeType.split('/')[1] || 'png'}`; // Attempt to get extension from mime type
            console.log(`Received inline image data (MIME: ${mimeType})`);
        } else if (imagePart.fileData) { // If Gemini provides a file URI or similar
            // This part needs implementation based on how Google returns fileData (e.g., fetching from a URI)
             console.warn("Received fileData for image, handling not fully implemented yet. Assuming PNG for now.");
             // imageDataBuffer = await fetchAndDecodeSomehow(imagePart.fileData.fileUri); // Placeholder
             throw new Error("Image generation returned fileData, which is not yet handled in this script.");
        } else if (imagePart.blob) { // If it's a blob object (less common in Node.js context)
             throw new Error("Image generation returned a Blob object, which is not directly handled in this Node.js script.");
        }
        else {
             throw new Error("Unrecognized image data format in Gemini response.");
        }


        const imageName = `gemini-${Date.now()}-${baseFilename}${imageExt}`;
        const imagePath = path.join(OUTPUT_IMAGES_DIR, imageName);
        const relativeImagePathForMarkdown = `/${path.basename(OUTPUT_IMAGES_DIR)}/${imageName}`.replace(/\\/g, '/'); // Relative path

        console.log(`Saving generated image to ${imagePath}...`);
        await fs.writeFile(imagePath, imageDataBuffer);

        console.log(`Image successfully saved as ${imagePath}`);
        return { success: true, markdown: `\n\n![Generated Image](${relativeImagePathForMarkdown})\n\n` };

    } catch (error) {
        console.error(`Error generating or saving image for prompt "${imagePromptContent.substring(0,100)}...":`, error.message || error);
         // Log more details if available from Gemini response
         if (error.response) { // If error has response property (less common for Gemini SDK errors)
             console.error("API Error Details:", JSON.stringify(error.response, null, 2));
         } else if (error.promptFeedback) { // Check for Gemini-specific feedback
              console.error("Gemini Prompt Feedback:", JSON.stringify(error.promptFeedback, null, 2));
         }
        return { success: false, error: error.message, markdown: '\n\n<!-- Image Generation Failed -->\n\n' };
    }
}


// --- Core Processing Logic ---

// Helper to convert image URL/path to Gemini part
async function urlToGenerativePart(url, mimeType = "image/jpeg") { // Default to JPEG
     console.log(`Downloading image for vision processing: ${url}`);
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 }); // 20s timeout
        return {
            inlineData: {
                data: Buffer.from(response.data, 'binary').toString("base64"),
                mimeType
            },
        };
    } catch (error) {
         console.error(`Failed to download or convert image ${url}: ${error.message}`);
         if (axios.isAxiosError(error) && error.response?.status === 404) {
             console.warn(`Image URL returned 404 Not Found.`);
         } else if (axios.isAxiosError(error)) {
             console.error("Axios Error Details:", { code: error.code, message: error.message, url: error.config?.url });
         }
         return null; // Indicate failure
    }
}

async function processOriginalImage(imageUrl) {
    if (!imageUrl || typeof imageUrl !== 'string') return "";

    console.log(`Processing original image with vision model: ${imageUrl}`);
    let imagePart = null;
    try {
         // Attempt to guess mime type, default to jpeg
         let mimeType = "image/jpeg";
         const extension = path.extname(imageUrl.split('?')[0]).toLowerCase(); // Get ext before query params
         if (extension === '.png') mimeType = "image/png";
         else if (extension === '.webp') mimeType = "image/webp";
         else if (extension === '.gif') mimeType = "image/gif"; // Gemini might support GIF

        imagePart = await urlToGenerativePart(imageUrl, mimeType);
         if (!imagePart) {
              throw new Error("Failed to download or prepare image part.");
         }

    } catch (prepError) {
         console.error(`Error preparing image ${imageUrl} for vision model:`, prepError.message);
         return "<!-- Vision processing failed: Could not prepare image -->\n\n";
    }


    try {
        const visionPrompt = "Compose a descriptive Shakespearean Sonnet inspired by this image.";
        // Use the visionModel (or textModel if it handles vision)
        const result = await visionModel.generateContent([visionPrompt, imagePart]);
        const response = result.response; // Use await result.response
        const sonnet = response?.text?.(); // Use optional chaining and call text()

        if (!sonnet) {
             const blockReason = response?.promptFeedback?.blockReason;
             const safetyRatings = response?.candidates?.[0]?.safetyRatings;
             console.warn(`Vision model returned empty content for image: ${imageUrl}`, { blockReason, safetyRatings });
             return `<!-- Vision processing returned no content for original image. Reason: ${blockReason || 'Unknown'} -->\n\n`;
        }
        const encodedImageUrl = encodeURI(imageUrl); // Basic encoding
        return `### Sonnet for Original Image\n\n![](${encodedImageUrl})\n\n${sonnet.trim()}\n\n`;
    } catch (error) {
        console.error(`Error processing original image (${imageUrl}) with vision model:`, error.message || error);
         if (error.promptFeedback) {
             console.error("Gemini Prompt Feedback:", JSON.stringify(error.promptFeedback, null, 2));
         } else if (error.message.includes("429") || error.message.includes("Resource has been exhausted")) {
             console.warn("Vision processing failed due to rate limiting (429). Consider adding delays.");
         }
        return "<!-- Vision processing failed for original image -->\n\n";
    }
}

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
            if (inputData.hasOwnProperty('content') && inputData.hasOwnProperty('title') && inputData.hasOwnProperty('source')) {
                console.log(`Applying transformation to structure with content/title/source for ${inputFile}...`);
                inputData = transformInputJson(inputData);
            } else {
                console.warn(`Skipping ${inputFile}: Does not have 'ogResult' or a known transformable structure.`);
                return;
            }
        }

        // Ensure essential fields
        inputData.ogResult = inputData.ogResult || {};
        inputData.ogResult.ogTitle = inputData.ogResult.ogTitle || inputData.name || 'Untitled';
        inputData.ogResult.ogUrl = inputData.ogResult.ogUrl || inputData.url || '';
        inputData.ogHTML = inputData.ogHTML || '';
        inputData.ogResult.ogImage = inputData.ogResult.ogImage || [];
        inputData.youtube = inputData.youtube || {};

        // 3. Create JSON Copy
        const jsonCopyFilename = inputFile;
        const jsonCopyPath = path.join(JSON_COPY_DIR, jsonCopyFilename);
        await fs.writeFile(jsonCopyPath, JSON.stringify(inputData, null, 2));
        console.log(`Copied processed JSON structure to ${jsonCopyPath}`);

        // 4. Extract Original Image URL
        let originalImageUrl = null;
        if (Array.isArray(inputData.ogResult.ogImage) && inputData.ogResult.ogImage.length > 0) {
            originalImageUrl = inputData.ogResult.ogImage[0]?.url ||
                              (typeof inputData.ogResult.ogImage[0] === 'string' ? inputData.ogResult.ogImage[0] : null);
        }

        // 5. Aggregate Text Content & Clean
        let fullTextContent = [
            inputData.ogResult?.ogUrl ?? '',
            inputData.ogResult?.ogTitle ?? '',
            inputData.ogResult?.ogDescription ?? '',
            inputData.youtube?.subtitles ?? ''
        ].filter(Boolean).join('\n');
        if (inputData.ogResult?.jsonLD && Array.isArray(inputData.ogResult.jsonLD)) {
            const article = inputData.ogResult.jsonLD.find(item => item.articleBody && typeof item.articleBody === 'string');
            if (article) {
                fullTextContent += `\n\n<blockquote cite="${inputData.ogResult?.ogUrl ?? ''}">Article Content (JSON-LD):\n${escapeHtml(article.articleBody)}</blockquote>`;
            }
        }
        const cleanedHtmlContent = (inputData.ogHTML ?? '')
            .replace(/<style[^>]*>.*<\/style>/gis, ' ')
            .replace(/<script[^>]*>.*<\/script>/gis, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/ | /gi, ' ')
            .replace(/&/gi, '&').replace(/</gi, '<').replace(/>/gi, '>').replace(/"/gi, '"').replace(/'/gi, "'")
            .replace(/\s{2,}/g, ' ')
            .trim();
        if (cleanedHtmlContent) {
            fullTextContent += `\n\nPage Content:\n${cleanedHtmlContent}`;
        }
        fullTextContent = fullTextContent.trim();

        if (fullTextContent.length === 0) {
            console.warn(`Skipping ${inputFile}: No text content found after aggregation and cleaning.`);
            return;
        }

        // 6. Process Original Image
        const imageSonnetPromise = processOriginalImage(originalImageUrl);

        // 7. Chunk Text Content
        const textChunks = [];
        if (fullTextContent.length <= MAX_CHUNK_SIZE_CHARS) {
            textChunks.push(fullTextContent);
        } else {
            console.log(`Text content is long (${fullTextContent.length} chars), chunking...`);
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
                const chunk = fullTextContent.substring(startIndex, endIndex).trim();
                if (chunk.length > 0) {
                    textChunks.push(chunk);
                }
                startIndex = endIndex;
                if (startIndex === fullTextContent.length) break;
                if (startIndex < endIndex) {
                    console.warn("Chunking startIndex did not advance properly. Breaking loop.");
                    break;
                }
            }
            console.log(`Split into ${textChunks.length} chunks.`);
            if (textChunks.length === 0) {
                console.warn(`Skipping ${inputFile}: Chunking resulted in no usable text content.`);
                return;
            }
        }

        // 8. Log Chunks for Debugging
        const debugLogPath = `logs/chunks-${Date.now()}.txt`;
        await fs.mkdir('logs', { recursive: true });
        await fs.writeFile(debugLogPath, `File: ${inputFile}\n`);
        for (let i = 0; i < textChunks.length; i++) {
            await fs.appendFile(debugLogPath, `Chunk ${i + 1}:\n${textChunks[i]}\n\n`);
        }
        console.log(`Logged chunks to ${debugLogPath}`);

        // 9. Prepare Text Chunk API Calls
        const textApiPromises = textChunks.map((chunk, index) => {
            console.log(`Preparing API call for text chunk ${index + 1}/${textChunks.length}`);
            const userPromptContent = selectedPrompt.chat.replace('[[chunk]]', chunk);
            const fullPromptForApi = `${selectedPrompt.system}\n\n${userPromptContent}`;
            return textModel.generateContent({
                contents: [{ role: "user", parts: [{ text: fullPromptForApi }] }],
                generationConfig: {
                    maxOutputTokens: 8192,
                    temperature: 1.0
                }
            }).catch(err => {
                const message = err.message || String(err);
                const feedback = err.promptFeedback ? JSON.stringify(err.promptFeedback) : 'N/A';
                console.error(`Error processing text chunk ${index + 1} for ${inputFile}: ${message}`, `Feedback: ${feedback}`);
                return { error: true, chunkIndex: index + 1, message, feedback };
            });
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
        const extractedVideoPrompts = [];

        textApiResults.forEach((result, index) => {
            const chunkNumber = index + 1;

            if (!result || result.error) {
                console.error(`Failed to get result for text chunk ${chunkNumber}. Error: ${result?.message}`);
                toc += `- ~~Verse ${chunkNumber} (Error)~~ \n`;
                combinedVerseOutput += `<h3 id="verse-${chunkNumber}">Verse ${chunkNumber}</h3>\n\n<p><em>Error processing this chunk. ${result?.feedback ? `(${result.feedback})` : ''}</em></p>\n\n`;
                return;
            }

            const response = result.response;
            const messageContent = response?.text?.()?.trim() ?? "";
            if (!messageContent) {
                const blockReason = response?.promptFeedback?.blockReason;
                const safetyRatings = response?.candidates?.[0]?.safetyRatings;
                console.warn(`Text model returned empty content for chunk ${chunkNumber}. Reason: ${blockReason || 'Empty response'}`, { safetyRatings });
                toc += `- [Verse ${chunkNumber}](#verse-${chunkNumber}) (Empty/Blocked Response)\n`;
                combinedVerseOutput += `<h3 id="verse-${chunkNumber}">Verse ${chunkNumber}</h3>\n\n<p><em>Model returned no content for this chunk. ${blockReason ? `(Reason: ${blockReason})` : ''}</em></p>\n\n`;
                return;
            }

            const sections = { verse: '', image: '', video: '' };
            let currentSection = 'verse';
            const lines = messageContent.split('\n');
            for (const line of lines) {
                const imageMatch = line.match(/^###\s*Image Prompt\s*$/i);
                const videoMatch = line.match(/^###\s*Video Prompt\s*$/i);
                const verseMatch = line.match(/^###\s*Verse\s*(\d*)\s*$/i);
                if (imageMatch) { currentSection = 'image'; }
                else if (videoMatch) { currentSection = 'video'; }
                else if (verseMatch) { currentSection = 'verse'; }
                else {
                    if (sections.hasOwnProperty(currentSection)) {
                        sections[currentSection] += line + '\n';
                    }
                }
            }
            Object.keys(sections).forEach(key => { sections[key] = sections[key]?.trim() ?? ''; });

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
                extractedVideoPrompts.push(videoPromptContent);
            }

            combinedVerseOutput += `<h3 id="verse-${chunkNumber}">Verse ${chunkNumber}</h3>\n\n<div>${escapeHtml(verseContent).replace(/\n/g, '<br>')}</div>\n\n`;
            if (imagePromptContent) {
                combinedVerseOutput += `<h4 id="image-prompt-${chunkNumber}">Image Prompt ${chunkNumber}</h4>\n\n<pre><code class="language-text">${escapeHtml(imagePromptContent)}</code></pre>\n\n`;
            }
            if (videoPromptContent) {
                combinedVerseOutput += `<h4 id="video-prompt-${chunkNumber}">Video Prompt ${chunkNumber}</h4>\n\n<pre><code class="language-text">${escapeHtml(videoPromptContent)}</code></pre>\n\n`;
            }
        });

        // 12. Generate Single Image
        let figureWithGeneratedImage = "";
        let promptUsedForImage = null;

        if (extractedImagePrompts.length > 0) {
            const randomIndex = Math.floor(Math.random() * extractedImagePrompts.length);
            promptUsedForImage = extractedImagePrompts[randomIndex];
            console.log(`Selected image prompt (index ${randomIndex}) for generation: "${promptUsedForImage.substring(0, 100)}..."`);
            const imageGenResult = await generateAndEmbedImage(promptUsedForImage, baseFilename);
            if (imageGenResult.success) {
                figureWithGeneratedImage = `
### Generated Image
${imageGenResult.markdown.trim()}
*Image generated using the prompt:*
<pre><code class="language-text">${escapeHtml(promptUsedForImage)}</code></pre>`;
            } else {
                figureWithGeneratedImage = `
### Generated Image
${imageGenResult.markdown} <!-- Error: ${escapeHtml(imageGenResult.error || 'Unknown image generation error')} -->
*Attempted to use prompt:*
<pre><code class="language-text">${escapeHtml(promptUsedForImage)}</code></pre>`;
                console.error(`Failed to generate image: ${imageGenResult.error}`);
            }
        } else {
            console.log("No image prompts were extracted. Skipping image generation.");
            figureWithGeneratedImage = "<!-- No image prompts found to generate an image -->";
        }

        // 13. Construct Final Markdown Output
        const promptHash = generatePromptHash(selectedPrompt.system + selectedPrompt.chat);
        const safeTitlePart = (inputData.ogResult.ogTitle || baseFilename)
            .replace(/[^\p{L}\p{N}_ -]/gu, '')
            .replace(/\s+/g, '_')
            .substring(0, 50);
        const modelNameClean = TEXT_MODEL_NAME.replace(/[^a-zA-Z0-9]/g, '');
        const outputFilename = `${safeTitlePart}-${modelNameClean}-${promptHash}.md`;
        const outputPath = path.join(OUTPUT_POSTS_DIR, outputFilename);
        const relativeJsonPath = `/${path.basename(JSON_COPY_DIR)}/${jsonCopyFilename}`.replace(/\\/g, '/');
        const fmTitle = (inputData.ogResult.ogTitle || 'Untitled').replace(/"/g, "''");

        const markdownOutput = `---
title: "${fmTitle}-${modelNameClean}-${selectedPrompt.name}"
author: Gemini
---

Source: [${inputData.ogResult.ogUrl}](${inputData.ogResult.ogUrl})

${toc}
<hr>

${combinedVerseOutput}

<hr>
${imageSonnetResult}

<hr>
${figureWithGeneratedImage}

<hr>

### Generation Details
<details>
  <summary>Click to view Models and Prompt</summary>
  <p><strong>Text Model:</strong> ${TEXT_MODEL_NAME}<br>
  <strong>Vision Model:</strong> ${VISION_MODEL_NAME}<br>
  <strong>Image Gen Model:</strong> ${IMAGE_GEN_MODEL_NAME}</p>
  <p><strong>Prompt Used (Name: ${selectedPrompt.name}):</strong></p>
  <strong>System Instructions:</strong>
  <pre><code class="language-text">${escapeHtml(selectedPrompt.system)}</code></pre>
  <strong>Chat Template (with [[chunk]] placeholder):</strong>
  <pre><code class="language-text">${escapeHtml(selectedPrompt.chat)}</code></pre>
</details>

<hr>
<button onclick="loadAndDisplayJSON()">Load Input JSON Data</button>
<div id="jsonDisplay" style="display: none;"><pre><code class="language-json"></code></pre></div>

<!-- Highlight.js should be included in the site template -->
<script>
function loadAndDisplayJSON() {
    window.open('/js/${relativeJsonPath}', '_blank');
}
</script>
`;

        // 14. Write Output File
        await fs.writeFile(outputPath, markdownOutput);
        console.log(`Successfully generated Markdown: ${outputPath}`);

    } catch (error) {
        console.error(`\n--- ERROR processing file ${currentInputFile} ---`);
        console.error(error.stack || error);
    } finally {
        currentInputFile = '';
        currentInputPath = '';
    }
}

// --- Utility Functions (Copied from groem7.js) ---
function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') {
       // Handle null, undefined, numbers, booleans gracefully
       return unsafe === null || unsafe === undefined ? '' : String(unsafe);
    }
    return unsafe
         .replace(/&/g, "&") // Must be first
         .replace(/</g, "<")
         .replace(/>/g, ">")
         .replace(/"/g, "\"")
         .replace(/'/g, "'"); // Escape single quotes
}

function generatePromptHash(promptText, length = 8) {
    let hash = 0;
     if (!promptText || typeof promptText !== 'string' || promptText.length === 0) return 'noPrompt'; // Handle empty/invalid input
    for (let i = 0; i < promptText.length; i++) {
        const char = promptText.charCodeAt(i);
        hash = ((hash << 5) - hash) + char; // Simple hash function (same as in groem7)
        hash |= 0; // Convert to 32bit integer
    }
     // Return positive hex representation, padded if needed (though substring usually handles length)
     return Math.abs(hash).toString(16).padStart(length, '0').substring(0, length);
}


// --- Main Execution ---
async function main() {
    console.log("Starting Gemini processing script (goem6.js)...");
    try {
        // Ensure Output Dirs Exist
        await fs.mkdir(OUTPUT_POSTS_DIR, { recursive: true });
        await fs.mkdir(OUTPUT_IMAGES_DIR, { recursive: true });
        await fs.mkdir(JSON_COPY_DIR, { recursive: true }); // Ensure JSON copy dir exists
        console.log(`Ensured directories exist: ${OUTPUT_POSTS_DIR}, ${OUTPUT_IMAGES_DIR}, ${JSON_COPY_DIR}`);

        // Load Prompts
        await loadAndPreparePrompts(); // Load prompts into availablePrompts

        // Select Prompt & Update State
        const promptIndexToUse = getNextPromptIndexSync(); // Get index after prompts are loaded
        if (availablePrompts.length === 0) { // Check again after loading
             console.error("FATAL: No valid prompts were loaded. Exiting.");
             process.exit(1);
        }
        const selectedPrompt = availablePrompts[promptIndexToUse];
        console.log(`Selected prompt for this run: ${selectedPrompt.name} (Index: ${promptIndexToUse})`);
        setPromptIndexSync(promptIndexToUse); // Save the index used for the next run

        // Find Input Files
        let files;
        try {
             files = await fs.readdir(INPUT_DATA_DIR);
        } catch (err) {
             if (err.code === 'ENOENT') {
                 console.error(`FATAL: Input data directory not found: ${INPUT_DATA_DIR}`);
                 process.exit(1);
             } else {
                 console.error(`FATAL: Error reading input directory ${INPUT_DATA_DIR}:`, err);
                 throw err; // Re-throw other errors
             }
        }

        const jsonFiles = files.filter(file => path.extname(file).toLowerCase() === '.json');

        if (jsonFiles.length === 0) {
            console.log(`No JSON files found in ${INPUT_DATA_DIR}. Exiting.`);
            return; // Exit gracefully
        }
        console.log(`Found ${jsonFiles.length} JSON files to process.`);

        // Process Files Sequentially (or adapt for parallel processing if desired and safe for APIs)
        for (const file of jsonFiles) {
            // Add a small delay between files to potentially avoid rapid-fire API limits
             await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay
            await processSingleFile(file, selectedPrompt);
        }

        console.log("\n--- Script finished ---");

    } catch (error) {
        console.error("\n--- FATAL ERROR during script execution ---");
        console.error(error.stack || error);
        process.exit(1); // Exit with error code
    }
}

// Execute main function
main();

// --- END OF NEW FILE goem6.js ---
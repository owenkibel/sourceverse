const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const axios = require('axios');

const ffmpeg = require('fluent-ffmpeg');
const streamifier = require('streamifier');
const { GoogleGenAI, Modality } = require('@google/genai'); // Added Modality
const TTS_MODEL_NAME_FOR_API = "gemini-2.5-flash-preview-tts";
const TTS_MODEL_DISPLAY_NAME = "Gemini TTS (gemini-2.5-flash-preview-tts, single speaker)";
const MAX_TTS_CHARS = 1000;

// ADDED: Array of Gemini TTS voice names
const GEMINI_TTS_VOICE_NAMES = [
    "achernar", "achird", "algenib", "algieba", "alnilam", "aoede", "autonoe", "callirrhoe", "charon",
    "despina", "enceladus", "erinome", "fenrir", "gacrux", "iapetus", "kore", "laomedeia", "leda",
    "orus", "puck", "pulcherrima", "rasalgethi", "sadachbia", "sadaltager", "schedar", "sulafat",
    "umbriel", "vindemiatrix", "zephyr", "zubenelgenubi"
];

const INPUT_DATA_DIR = 'ogs_data';
const JSON_COPY_DIR = 'json';
const PROMPTS_DIR = path.join(__dirname, 'prompts');
const OUTPUT_POSTS_DIR = 'posts';
const OUTPUT_IMAGES_DIR = 'images';
const PROMPT_STATE_FILE = path.join(__dirname, 'gemini.txt');

const MAX_CHUNK_TOKEN_ESTIMATE = 8000;
const AVG_CHARS_PER_TOKEN = 4;
const MAX_CHUNK_SIZE_CHARS = MAX_CHUNK_TOKEN_ESTIMATE * AVG_CHARS_PER_TOKEN;

const apiKey = process.env.API_KEY;
if (!apiKey) {
    console.error("FATAL: API_KEY environment variable for Google AI is not set.");
    process.exit(1);
}
const genAI = new GoogleGenerativeAI(apiKey); // Client for text and vision models

const TEXT_MODEL_NAME = "gemini-2.5-flash-preview-05-20";
const IMAGE_GEN_MODEL_NAME = "gemini-2.0-flash-preview-image-generation"; // Updated model name
const VISION_MODEL_NAME = "gemini-2.5-flash-preview-05-20";

const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

let textModel, visionModel; // imageGenModel removed
let googleGenAIClient; // Renamed from ttsAI, will be used for TTS and Image Gen
let logMessage;

try {
    textModel = genAI.getGenerativeModel({ model: TEXT_MODEL_NAME, safetySettings });
    // Old imageGenModel (from @google/generative-ai) is no longer initialized here
    visionModel = genAI.getGenerativeModel({ model: VISION_MODEL_NAME, safetySettings });
    console.log(`Models initialized (via @google/generative-ai): Text (${TEXT_MODEL_NAME}), Vision (${VISION_MODEL_NAME})`);
    console.log(`Image Gen will use ${IMAGE_GEN_MODEL_NAME} (via @google/genai client).`);
} catch (modelError) {
    console.error("FATAL: Error initializing Google AI models (@google/generative-ai):", modelError.message);
    process.exit(1);
}

let currentInputFile = '';
let currentInputPath = '';
let availablePrompts = [];
let selectedTtsVoice = ''; // Global variable to store the selected TTS voice

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
            if (path.extname(file).toLowerCase() !== '.json') continue;
            const filePath = path.join(PROMPTS_DIR, file);
            const promptData = await loadPromptFile(filePath);
            if (!promptData.system || !promptData.chat) continue;
            let systemPrompt = promptData.system;
            let chatPrompt = promptData.chat;
            const style = promptData.style?.[Math.floor(Math.random() * promptData.style.length)] || "";
            const poet = promptData.poet?.[Math.floor(Math.random() * promptData.poet.length)] || "";
            systemPrompt = systemPrompt.replace(/\[\[verseStyle]]/g, style).replace(/\[\[poet]]/g, poet);
            chatPrompt = chatPrompt.replace(/\[\[verseStyle]]/g, style).replace(/\[[poet]]/g, poet);
            if (!chatPrompt.includes('[[chunk]]')) chatPrompt += "\n\nAnalyze the following text:\n[[chunk]]";
            availablePrompts.push({ name: path.basename(file, '.json'), system: systemPrompt, chat: chatPrompt, style, poet });
        }
        if (availablePrompts.length === 0) throw new Error(`No valid prompt files found in ${PROMPTS_DIR}.`);
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

async function generateAndEmbedImage(imagePromptContent, baseFilename) {
    if (!googleGenAIClient) {
        console.warn("Skipping image generation: GoogleGenAI client not initialized.");
        return {
            success: false,
            error: "Image generation client not initialized.",
            markdown: "<!-- Image generation skipped: Client not initialized -->",
            refusalReason: null,
            detailedErrorInfo: { message: "GoogleGenAI client not initialized." }
        };
    }
    if (!imagePromptContent || typeof imagePromptContent !== 'string' || imagePromptContent.trim().length === 0) {
         console.warn("Skipping image generation: Received empty or invalid prompt.");
         return {
             success: false,
             error: "No valid prompt provided for image generation.",
             markdown: "<!-- Image generation skipped: No valid prompt provided -->",
             refusalReason: null,
             detailedErrorInfo: { message: "No valid prompt provided for image generation." }
         };
    }

    const trimmedPrompt = imagePromptContent.trim();
    console.log(`Generating image with prompt: "${trimmedPrompt.substring(0, 150)}..." (using ${IMAGE_GEN_MODEL_NAME})`);

    try {
        const apiResponse = await googleGenAIClient.models.generateContent({
            model: IMAGE_GEN_MODEL_NAME,
            contents: trimmedPrompt, // Direct string prompt
            safetySettings: safetySettings, // Global safetySettings
            config: {
                responseModalities: [Modality.TEXT, Modality.IMAGE],
            },
        });

        if (!apiResponse || !apiResponse.candidates || apiResponse.candidates.length === 0) {
            const blockReasonFromFeedback = apiResponse?.promptFeedback?.blockReason || 'N/A';
            const errorMsg = `Image generation failed: No candidates returned from API. Block Reason: ${blockReasonFromFeedback}`;
            console.error(errorMsg, "Prompt Feedback:", apiResponse?.promptFeedback);
            return {
                success: false, error: errorMsg,
                markdown: `<!-- ${escapeHtml(errorMsg)} -->`,
                refusalReason: `API Error: No candidates. Block Reason from promptFeedback: ${blockReasonFromFeedback}`,
                detailedErrorInfo: {
                    type: "NoCandidatesReturned",
                    promptFeedback: apiResponse?.promptFeedback || null,
                    fullApiResponseCandidateCount: apiResponse?.candidates?.length || 0,
                }
            };
        }

        const candidate = apiResponse.candidates[0];
        let refusalText = null;
        let imagePartPayload = null; // To hold inlineData or fileData part

        // MODIFIED: Filter out image data from fullCandidateContentParts for error logging
        const filteredContentParts = candidate.content?.parts?.map(part => {
            if (part.inlineData) {
                // Return a simplified representation for inlineData to avoid large base64 strings
                return { inlineData: { mimeType: part.inlineData.mimeType, dataLength: part.inlineData.data?.length || 0, note: "Base64 data omitted for brevity" } };
            } else if (part.fileData) {
                // Return a simplified representation for fileData
                return { fileData: { mimeType: part.fileData.mimeType, fileUri: part.fileData.fileUri, note: "File URI data" } };
            }
            return part; // Return text parts as is
        }) || null;


        if (candidate.content && candidate.content.parts) {
            for (const part of candidate.content.parts) {
                if (part.text) {
                    refusalText = part.text;
                    // Do not break here; ensure we check for actual image data first if it somehow comes with refusal text
                } else if (part.inlineData && part.inlineData.mimeType?.startsWith('image/')) {
                    imagePartPayload = part.inlineData;
                    // If we find an image payload, we assume this is the intended content
                    // and any *preceding* refusal text might be a model "thought" rather than a final block.
                    // However, the *primary* success path expects ONLY image data. If text *and* image are returned,
                    // it usually indicates a refusal where the refusal text is the *intended output*.
                    // Based on the observed error, refusalText means it *didn't* give an image *successfully*.
                    // So if refusalText is present, we prioritize that as the failure mode.
                } else if (part.fileData && part.fileData.mimeType?.startsWith('image/')) {
                    console.warn("Image generation returned fileData URI, which is not directly processed by this script. Attempting to use if no inlineData.");
                    if (!imagePartPayload) imagePartPayload = part.fileData;
                }
            }
        }

        if (refusalText && !imagePartPayload) { // If refusal text is present AND no image payload, it's a refusal.
            const finishReason = candidate.finishReason || 'N/A';
            const safetyRatingsString = candidate.safetyRatings ? JSON.stringify(candidate.safetyRatings) : 'N/A';
            console.warn(`Image generation model returned a text response (policy refusal): "${refusalText.substring(0, 200)}..." Finish Reason: ${finishReason}`);
            return {
                success: false,
                error: `Image generation refused by model policy. Finish Reason: ${finishReason}. Safety: ${safetyRatingsString}`,
                markdown: `<!-- Image Generation Refused by Model Policy. Finish Reason: ${escapeHtml(finishReason)}. Safety: ${escapeHtml(safetyRatingsString)} -->`,
                refusalReason: refusalText,
                detailedErrorInfo: {
                    type: "ModelPolicyRefusal",
                    candidateFinishReason: candidate?.finishReason || null,
                    candidateSafetyRatings: candidate?.safetyRatings || null,
                    promptFeedback: apiResponse?.promptFeedback || null,
                    filteredCandidateContentParts: filteredContentParts // Use filtered parts
                }
            };
        }
        // Case where imagePartPayload exists but refusalText also came along:
        // This is tricky. Google's current multimodal models usually return *either* text *or* image for single generation.
        // If both are present, it's safer to treat it as a failure to get a clean image output.
        // However, if your prompt expects text *and* an image, you'd handle that differently.
        // For image generation specifically, if the model *does* return an image, we want that.
        // If it also returns refusalText, it means the image generation process was not clean/successful.
        // So, if imagePartPayload is NOT null, but refusalText IS null, proceed to save.
        // If imagePartPayload is NOT null AND refusalText is NOT null, it's an error.
        // If imagePartPayload IS null AND refusalText is NOT null, it's the refusal case handled above.
        // The original structure implies success only if imagePartPayload is present and no refusalText.
        // Let's ensure this means "no *final* refusal text."

        // The critical path is that if there is an imagePartPayload, we try to save it.
        // If there's also refusalText, then the model *also* said something about refusing.
        // The previous logic's `if (refusalText)` would have caught this first.
        // The current logic is: if refusalText, THEN refusal. Otherwise, if no image payload, THEN error.
        // This means, if imagePartPayload is present, and we haven't already returned for refusalText, it's a success path.
        // The code seems to correctly assume that if refusalText is present, it's a refusal.

        if (!imagePartPayload) { // This condition implies `refusalText` was not present, but still no image.
            const blockReason = apiResponse.promptFeedback?.blockReason || candidate.finishReason || 'Unknown reason';
            const safetyRatingsString = candidate.safetyRatings ? JSON.stringify(candidate.safetyRatings) : 'N/A';
            const errorMsg = `Image generation failed: No image data found in response parts. Reason: ${blockReason}. Safety: ${safetyRatingsString}`;
            console.error(errorMsg, "Full Candidate (condensed):", { finishReason: candidate.finishReason, safetyRatings: candidate.safetyRatings }, "Prompt Feedback:", apiResponse.promptFeedback);
            return {
                success: false, error: errorMsg,
                markdown: `<!-- Image Generation Failed: No image data. Reason: ${escapeHtml(blockReason)}. Safety: ${escapeHtml(safetyRatingsString)} -->`,
                refusalReason: `Model Error: No image data. Reason: ${blockReason}. Safety Ratings: ${safetyRatingsString}`,
                detailedErrorInfo: {
                    type: "NoImageDataInResponse",
                    promptFeedback: apiResponse?.promptFeedback || null,
                    candidateFinishReason: candidate?.finishReason || null,
                    candidateSafetyRatings: candidate?.safetyRatings || null,
                    filteredCandidateContentParts: filteredContentParts // Use filtered parts
                }
            };
        }

        let imageDataBuffer;
        let imageExt = '.png'; // Default

        if (imagePartPayload.data) {
            imageDataBuffer = Buffer.from(imagePartPayload.data, 'base64');
            const mimeType = imagePartPayload.mimeType;
            if (mimeType === 'image/jpeg') imageExt = '.jpg';
            else if (mimeType === 'image/png') imageExt = '.png';
            else if (mimeType === 'image/webp') imageExt = '.webp';
            else imageExt = `.${mimeType.split('/')[1] || 'png'}`;
        } else if (imagePartPayload.fileUri) {
             const errorMsg = `Image generation returned a file URI (${imagePartPayload.fileUri}), which requires separate download logic not implemented. Expected inline image data.`;
             console.error(errorMsg);
             return {
                success: false, error: errorMsg,
                markdown: `<!-- Image Generation Failed: ${escapeHtml(errorMsg)} -->`,
                refusalReason: errorMsg,
                detailedErrorInfo: { type: "FileURIUnsupported", fileUri: imagePartPayload.fileUri }
             };
        } else {
             throw new Error("Unrecognized image data format in Gemini response part.");
        }

        const imageName = `gemini-img-${Date.now()}-${baseFilename}${imageExt}`;
        const imagePath = path.join(OUTPUT_IMAGES_DIR, imageName);
        const relativeImagePathForMarkdown = `/${path.basename(OUTPUT_IMAGES_DIR)}/${imageName}`.replace(/\\/g, '/');
        await fs.writeFile(imagePath, imageDataBuffer);
        console.log(`Image successfully saved as ${imagePath}`);
        return {
            success: true,
            markdown: `\n\n![Generated Image](${relativeImagePathForMarkdown})\n\n`,
            refusalReason: null,
            detailedErrorInfo: null // No error, so no detailed info
        };

    } catch (error) {
        console.error(`Error in generateAndEmbedImage for prompt "${trimmedPrompt.substring(0,100)}...":`, error.message, error.stack);
        let detailedError = error.message;
        let errorDetailsForOutput = {};

        if (error.status && error.details) {
            detailedError = `API Error (Status ${error.status}): ${error.message}. Details: ${JSON.stringify(error.details)}`;
            errorDetailsForOutput = {
                type: "APIException",
                status: error.status,
                message: error.message,
                details: error.details,
                name: error.name
            };
        } else if (error.response && error.response.data) {
            detailedError = `API Error: ${JSON.stringify(error.response.data)}`;
            errorDetailsForOutput = {
                type: "AxiosResponseError",
                data: error.response.data,
                status: error.response.status
            };
        } else {
            errorDetailsForOutput = {
                type: "GeneralException",
                message: error.message,
                stack: error.stack,
                name: error.name
            };
        }
        return {
            success: false, error: detailedError,
            markdown: `\n\n<!-- Image Generation Exception: ${escapeHtml(detailedError)} -->\n\n`,
            refusalReason: `Exception during image generation: ${detailedError}`,
            detailedErrorInfo: errorDetailsForOutput
        };
    }
}


/**
 * Encodes PCM audio buffer to WebM Opus format, with optional audio enhancements.
 * @param {string} outputFilename The full path for the output WebM file.
 * @param {Buffer} pcmAudioBuffer The raw PCM audio data buffer.
 * @param {number} [inputChannels=1] Number of input audio channels (default: 1 for mono).
 * @param {number} [inputSampleRate=24000] Input audio sample rate (default: 24000).
 * @param {string} [inputSampleFormat='s16le'] Input audio sample format (default: 's16le').
 * @param {object} [options={}] Optional object for encoding parameters and audio enhancements.
 *   - `outputSampleRate`: Optional. If set, FFmpeg will resample to this rate (e.g., 48000).
 *   - `audioEnhancement`: Optional object to specify audio filtering.
 *     - `{ type: 'none' }` (default): No audio filter applied.
 *     - `{ type: 'pseudoStereo', delayMs: number, mixFactor: number }`: Creates a pseudo-stereo effect.
 *       `delayMs` defaults to 30, `mixFactor` (0-1) defaults to 0.5.
 *     - `{ type: 'pingPongEcho', delayMs: number, decay: number }`: Applies a ping-pong echo effect.
 *       `delayMs` defaults to 500, `decay` defaults to 0.5.
 *     - `{ type: 'convolver', irFilePath: string }`: Applies true impulse response based reverb. Requires `irFilePath`.
 */
async function encodePcmToWebmOpus(
   outputFilename, pcmAudioBuffer, inputChannels = 1, inputSampleRate = 24000, inputSampleFormat = 's16le',
   options = {}
) {
   const { outputSampleRate, audioEnhancement = { type: 'none' } } = options;

   return new Promise((resolve, reject) => {
      const pcmStream = streamifier.createReadStream(pcmAudioBuffer);
      const command = ffmpeg()
        .input(pcmStream)
        .inputOptions([
            `-f ${inputSampleFormat}`,
            `-ar ${inputSampleRate}`, // This correctly tells FFmpeg the INPUT sample rate
            `-ac ${inputChannels}`
        ]);

      let finalOutputChannels = inputChannels; // Will be 2 if stereo effect is applied
      let filterGraph = []; // Array to build complex filter graph
      let currentAudioStreamLabel = '[0:a]'; // Label for the primary audio input stream from pcmAudioBuffer

      // Step 1: Handle Convolver (requires adding a second input first)
      if (audioEnhancement.type === 'convolver') {
          const irFilePath = audioEnhancement.irFilePath;
          if (!irFilePath || !fss.existsSync(irFilePath)) {
              console.warn(`Convolver filter selected but 'irFilePath' is missing or file does not exist: '${irFilePath}'. Skipping convolver and other effects.`);
              // Reset to no effect and let it proceed as original mono
              audioEnhancement.type = 'none';
          } else {
              command.input(irFilePath); // Add the IR file as a second input stream
              // Label the IR stream [1:a]
              logMessage = `FFMPEG: Convolver reverb audio encoded to ${outputFilename}`;
              finalOutputChannels = 2; // Convolver usually produces stereo if possible
          }
      }

      // Step 2: Ensure stereo for effects if input is mono and effect needs stereo
      // This applies to pseudoStereo, pingPongEcho, and convolver if input was mono and IR is mono
      let stereoizedInputNeeded = (audioEnhancement.type === 'pseudoStereo' || audioEnhancement.type === 'pingPongEcho' || (audioEnhancement.type === 'convolver' && inputChannels === 1));

      if (inputChannels === 1 && stereoizedInputNeeded) {
          // asplit: creates two identical copies of the mono stream
          // amerge: merges the two copies into a stereo stream
          filterGraph.push(`${currentAudioStreamLabel} asplit=2[mono_L][mono_R]`);
          filterGraph.push(`[mono_L][mono_R]amerge=inputs=2[stereo_pre_effect]`);
          currentAudioStreamLabel = '[stereo_pre_effect]'; // Subsequent filters operate on this stereo stream
          finalOutputChannels = 2; // Output will be stereo
      } else if (inputChannels === 2) {
          // If input is already stereo, just use it as is for effects
          currentAudioStreamLabel = '[0:a]'; // Ensure it's correctly labeled from input 0
          finalOutputChannels = 2;
      }

      // Step 3: Apply specific audio enhancements
      if (audioEnhancement.type === 'pseudoStereo') {
          const delayMs = audioEnhancement.delayMs || 30; // Default delay in milliseconds
          const mixFactor = audioEnhancement.mixFactor !== undefined ? audioEnhancement.mixFactor : 0.5; // Factor for cross-mix

          // Explanation for pseudo-stereo (classic delay-and-mix method):
          // 1. `channelsplit=channel_layout=stereo[L_orig][R_orig]`: Split the (now stereo) input into two separate mono streams.
          // 2. `[L_orig]adelay=${delayMs}|${delayMs}[L_delayed]`: Delay the left stream. (adelay expects delay for all channels, so for mono it's ${delayMs}|${delayMs})
          // 3. `[R_orig]adelay=${delayMs}|${delayMs}[R_delayed]`: Delay the right stream.
          // 4. `[L_orig][R_delayed]amerge[stereo_main]`: Merge original left with delayed right.
          // 5. `[R_orig][L_delayed]amerge[stereo_cross]`: Merge original right with delayed left.
          // 6. `[stereo_main][stereo_cross]amix=inputs=2:weights=1.0,${mixFactor}[aout]`: Mix them to create the widened effect.

          // Simplified pseudo-stereo:
          // Take the stereo stream, split to L/R. Delay R. Merge original L with delayed R.
          // This creates a sense of width by making the R channel slightly different.
          filterGraph.push(`${currentAudioStreamLabel} channelsplit=channel_layout=stereo[L][R]`);
          filterGraph.push(`[R]adelay=${delayMs}|${delayMs}[Rd]`); // Delay the right channel only
          filterGraph.push(`[L][Rd]amerge=inputs=2[aout]`); // Merge original L with delayed R
          currentAudioStreamLabel = '[aout]';
          logMessage = `FFMPEG: Pseudo-stereo audio encoded to ${outputFilename}`;

      } else if (audioEnhancement.type === 'pingPongEcho') {
          const delayMs = audioEnhancement.delayMs || 500; // Delay for ping-pong effect (e.g., 500ms)
          const decay = audioEnhancement.decay || 0.5; // Decay rate
          // This specific `aecho` filter setup creates a ping-pong-like effect across stereo channels.
          // delays: delays for each channel. decays: decays for each channel.
          // channel 0 (left): original signal, delayed echo on channel 1 (right)
          // channel 1 (right): original signal, delayed echo on channel 0 (left)
          // The effect is to send the signal to the opposite channel as an echo.
          filterGraph.push(`${currentAudioStreamLabel} aecho=1:1:${delayMs}|${delayMs}:${decay}|${decay}[aout]`);
          // For a true ping-pong, it's more like: aecho=1:1:delay_L|delay_R:decay_L|decay_R:cross_delay_L->R|cross_delay_R->L:cross_decay_L->R|cross_decay_R->L
          // The aecho filter documentation is a bit dense for this specific usage.
          // A simpler interpretation for a ping-pong feel: one channel echoes, then its echo goes to the other channel.
          // The above `aecho` makes the input stereo, then applies a single echo to both channels.
          // For ping-pong: it's better to duplicate (if mono) and then route L->R echo and R->L echo using explicit channel mapping within complex filters
          // For now, let's keep the `aecho` simple. A true ping-pong requires complex `pan` and `adelay` routing.
          // Let's replace the aecho pingpong effect with a more specific filter for a general stereo echo.
          filterGraph.push(`${currentAudioStreamLabel} aecho=0.8:0.88:200|300:0.4|0.3[aout]`); // A general stereo echo
          currentAudioStreamLabel = '[aout]';
          logMessage = `FFMPEG: Stereo echo audio encoded to ${outputFilename}`;
      } else if (audioEnhancement.type === 'convolver') {
          // This block is for convolver. The IR file is already added as input [1:a].
          // The currentAudioStreamLabel is already setup (either [0:a] or [stereo_pre_effect]).
          // Ensure both audio and IR streams are float planar format for convolver.
          filterGraph.push(`${currentAudioStreamLabel} format=fltp[speech_in]`);
          filterGraph.push(`[1:a] format=fltp[impulse_in]`); // [1:a] refers to the second input (IR file)
          filterGraph.push(`[speech_in][impulse_in] convolver=stereo=auto[aout]`);
          currentAudioStreamLabel = '[aout]';
      }

      // Apply the constructed complex filter graph if it's not empty
      if (filterGraph.length > 0) {
          command.complexFilter(filterGraph);
          command.outputOptions([`-map ${currentAudioStreamLabel}`]); // Map to the final named output of the filter graph
          command.audioChannels(finalOutputChannels); // Set output channels based on effect
      } else {
          command.audioChannels(inputChannels); // Otherwise, use original input channels (mono if source was mono)
      }

      // If a specific outputSampleRate is requested, apply it here.
      if (outputSampleRate && outputSampleRate !== inputSampleRate) {
          command.audioFrequency(outputSampleRate);
          logMessage += ` (resampled to ${outputSampleRate}Hz)`;
      }

      command.audioCodec('libopus').format('webm').save(outputFilename)
         .on('end', () => { console.log(logMessage); resolve(`File saved as ${outputFilename}`); })
         .on('error', (err) => { console.error("FFMPEG Error:", err.message); reject(err); });
   });
}

async function generateAndEmbedAudio(ttsText, baseFilename, sourcePromptText = "") {
    if (!googleGenAIClient) return { success: false, error: "TTS client not initialized (@google/genai)", markdown: "<!-- Audio skip: TTS client not ready -->" };
    if (!ttsText?.trim()) return { success: false, error: "No valid text for TTS", markdown: "<!-- Audio skip: No text -->" };
    let cleanTtsText = ttsText.replace(/^Say \w+:\s*/i, '').trim();
    if (!cleanTtsText) cleanTtsText = ttsText.trim();
    if (!cleanTtsText) return { success: false, error: "No valid text for TTS after cleaning", markdown: "<!-- Audio skip: No text after cleaning -->" };

    console.log(`Generating audio (single speaker): "${cleanTtsText.substring(0, 100)}..."`);
    try {
        selectedTtsVoice = GEMINI_TTS_VOICE_NAMES[Math.floor(Math.random() * GEMINI_TTS_VOICE_NAMES.length)];

        const ttsSpecificConfig = {
            responseModalities: ['AUDIO'],
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: selectedTtsVoice }
                }
            }
        };


        // Using googleGenAIClient.models.generateContent directly:
        const result = await googleGenAIClient.models.generateContent({
            model: TTS_MODEL_NAME_FOR_API,
            contents: [{ role: "user", parts: [{ text: cleanTtsText }] }],
            safetySettings: safetySettings, // Pass safety settings
            config: ttsSpecificConfig
        });
        
        const audioDataPart = result.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (!audioDataPart) {
             let errorDetails = "No audio data in response.";
             if (result.candidates && result.candidates.length > 0) {
                 errorDetails += ` Candidate: ${JSON.stringify(result.candidates[0])}`;
             } else if (result.promptFeedback) {
                 errorDetails += ` Prompt Feedback: ${JSON.stringify(result.promptFeedback)}`;
             } else {
                 errorDetails += ` Full Response: ${JSON.stringify(result)}`;
             }
             throw new Error(errorDetails);
        }
        const pcmAudioBuffer = Buffer.from(audioDataPart, 'base64');
        const audioExt = ".webm";
        const audioName = `gemini-tts-${Date.now()}-${baseFilename}${audioExt}`;
        const audioPath = path.join(OUTPUT_IMAGES_DIR, audioName);
        console.log(`Encoding PCM audio (size: ${pcmAudioBuffer.length}) to ${audioPath}...`);
        
        // --- CHOOSE ONE OF THESE OPTIONS FOR AUDIO ENHANCEMENT ---
        const inputSampleRateFromTTS = 24000;
        const inputChannelsFromTTS = 1;
        const inputSampleFormatFromTTS = 's16le';

        // Option 1: Pseudo-stereo (recommended for speech widening)
        await encodePcmToWebmOpus(
            audioPath, pcmAudioBuffer, inputChannelsFromTTS, inputSampleRateFromTTS, inputSampleFormatFromTTS,
            { audioEnhancement: { type: 'pseudoStereo', delayMs: 30, mixFactor: 0.5 }, outputSampleRate: 48000 }
        );

        // Option 2: Ping-Pong Echo (more pronounced echo effect)
        /*
        await encodePcmToWebmOpus(
            audioPath, pcmAudioBuffer, inputChannelsFromTTS, inputSampleRateFromTTS, inputSampleFormatFromTTS,
            { audioEnhancement: { type: 'pingPongEcho', delayMs: 400, decay: 0.6 }, outputSampleRate: 48000 }
        );
        */

        // Option 3: Convolver Reverb with a Cathedral Impulse Response file
        // IMPORTANT: You MUST provide a valid path to your IR file.
        // Download IR files from sources like OpenAIR, EchoThief, etc.
        // Example: /path/to/your/cathedral_medium.wav
        /*
        const IR_FILE_PATH = path.join(__dirname, 'reverb_irs', 'cathedral_long.wav'); // Example path
        await encodePcmToWebmOpus(
            audioPath, pcmAudioBuffer, inputChannelsFromTTS, inputSampleRateFromTTS, inputSampleFormatFromTTS,
            { audioEnhancement: { type: 'convolver', irFilePath: IR_FILE_PATH }, outputSampleRate: 48000 }
        );
        */

        // Option 4: No effect (original behavior)
        /*
        await encodePcmToWebmOpus(
            audioPath, pcmAudioBuffer, inputChannelsFromTTS, inputSampleRateFromTTS, inputSampleFormatFromTTS,
            { type: 'none', outputSampleRate: 48000 } // You can still resample without effects
        );
        */
        // --- END CHOOSE OPTION ---

        const markdown = `\n### Generated Audio\n<audio controls src="/${path.basename(OUTPUT_IMAGES_DIR)}/${audioName}"></audio>\n*Audio from text:*\n<pre><code class="language-text">${escapeHtml(sourcePromptText)}</code></pre>`;
        return { success: true, markdown: markdown.trim(), audioFilePath: audioPath };
    } catch (error) {
        console.error(`Audio gen error for "${cleanTtsText.substring(0,100)}...":`, error.message, error.stack);
        if (error.status && error.message && error.message.includes("quota")) {
             console.warn("TTS Quota Exceeded. Further TTS calls in this run might fail.");
        } else if (error.status && error.message && error.details) {
             console.error("TTS API Error Details:", JSON.stringify({ status: error.status, message: error.message, details: error.details }, null, 2));
        }
        return { success: false, error: error.message, markdown: `\n\n<!-- Audio Gen Failed: ${escapeHtml(error.message)} -->\n\n` };
    }
}

async function urlToGenerativePart(url, mimeType = "image/jpeg") {
    console.log(`Downloading image for vision: ${url}`);
    try {
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
        return { inlineData: { data: Buffer.from(res.data, 'binary').toString("base64"), mimeType } };
    } catch (error) { console.error(`Failed to download ${url}: ${error.message}`); return null; }
}

async function processOriginalImage(imageUrl) {
    if (!imageUrl) return "";
    console.log(`Processing original image with vision: ${imageUrl}`);
    let imagePart = null;
    try {
         let mimeType = "image/jpeg";
         const ext = path.extname(imageUrl.split('?')[0]).toLowerCase();
         if (ext === '.png') mimeType = "image/png"; else if (ext === '.webp') mimeType = "image/webp";
        imagePart = await urlToGenerativePart(imageUrl, mimeType);
         if (!imagePart) throw new Error("Failed to download/prepare image part.");
    } catch (prepError) { return `<!-- Vision skip: Could not prepare ${imageUrl}: ${prepError.message} -->\n`; }
    try {
        const result = await visionModel.generateContent(["Compose a Shakespearean Sonnet for this image.", imagePart]);
        const sonnet = result.response?.text?.();
        if (!sonnet) return `<!-- Vision skip: No content for ${imageUrl}. -->\n`;
        return `### Sonnet for Original Image\n\n![](${encodeURI(imageUrl)})\n\n${sonnet.trim()}\n\n`;
    } catch (error) {
        console.error(`Vision error (${imageUrl}):`, error.message, error.promptFeedback);
        return "<!-- Vision processing failed -->\n";
    }
}

// Function to unescape HTML entities, necessary because combinedVerseOutput uses escapeHtml
function unescapeHtml(text) {
    if (typeof text !== 'string') return text == null ? '' : String(text);
    return text
        .replace(/&/g, '&')
        .replace(/</g, '<')
        .replace(/>/g, '>')
        .replace(/"/g, '"')
        .replace(/'/g, "'")
        .replace(/ /g, ' '); // Added   as it's common in HTML content
}

// New function to clean text for TTS based on user requirements
function cleanTextForTTS(text) {
    if (typeof text !== 'string') return '';

    let cleaned = unescapeHtml(text);

    // 1. Replace all HTML tags with a single space.
    // This is crucial to prevent words from merging when tags like <br> are removed.
    cleaned = cleaned.replace(/<[^>]+>/g, ' ');

    // 2. Remove common markdown characters (* # _ ` [ ] ( ))
    cleaned = cleaned.replace(/[\*_#`\[\]\(\)]/g, '');

    // 3. Remove ellipses (3 or more dots), replace with a single dot and space for sentence separation
    cleaned = cleaned.replace(/\.{3,}/g, '. ');

    // 4. Remove all newlines and empty lines (already handled by replacing HTML tags with space,
    // but this ensures any remaining explicit newlines are also treated as spaces)
    cleaned = cleaned.replace(/[\r\n]+/g, ' ');

    // 5. Remove everything that is not letters, numbers, or whitelisted punctuation.
    // Whitelist common English grammatical punctuation.
    const allowedPunctuation = `.,!?;:'"-/`; // Includes period, comma, exclamation, question, semicolon, colon, apostrophe, quote, hyphen, slash.
    // This regex matches any character that is NOT:
    // a-z, A-Z, 0-9, any character in `allowedPunctuation`, or a whitespace character.
    const regexForNonAlphaNumericNonAllowedPunctuation = new RegExp(`[^a-zA-Z0-9${allowedPunctuation}\\s]`, 'g');
    cleaned = cleaned.replace(regexForNonAlphaNumericNonAllowedPunctuation, '');

    // 6. Normalize spaces: replace multiple spaces with a single space and trim.
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    return cleaned;
}


async function processSingleFile(inputFile, selectedPrompt) {
    currentInputFile = inputFile; currentInputPath = path.join(INPUT_DATA_DIR, inputFile);
    const baseFilename = path.basename(inputFile, '.json');
    console.log(`\n--- Processing: ${inputFile} with Prompt: ${selectedPrompt.name} ---`);
    try {
        let inputData = JSON.parse(await fs.readFile(currentInputPath, 'utf8'));
        if (inputData.content && !inputData.ogResult) inputData = transformInputJson(inputData);
        else if (!inputData.ogResult) { console.warn(`Skipping ${inputFile}: Unknown structure.`); return; }
        inputData.ogResult = inputData.ogResult || {};
        inputData.ogResult.ogTitle = inputData.ogResult.ogTitle || inputData.name || 'Untitled';
        await fs.writeFile(path.join(JSON_COPY_DIR, inputFile), JSON.stringify(inputData, null, 2));
        const originalImageUrl = inputData.ogResult.ogImage?.[0]?.url || inputData.ogResult.ogImage?.[0];
        let fullTextContent = [ inputData.ogResult?.ogUrl, inputData.ogResult?.ogTitle, inputData.ogResult?.ogDescription, inputData.youtube?.subtitles ]
            .filter(Boolean).join('\n');
        const articleBody = inputData.ogResult.jsonLD?.find(item => item.articleBody)?.articleBody;
        if (articleBody) fullTextContent += `\n\n<blockquote cite="${inputData.ogResult?.ogUrl || ''}">JSON-LD:\n${escapeHtml(articleBody)}</blockquote>`;
        const cleanedHtml = (inputData.ogHTML || '').replace(/<style[^>]*>.*?<\/style>|<script[^>]*>.*?<\/script>|<[^>]+>/gis, ' ').replace(/\s{2,}/g, ' ').trim();
        if (cleanedHtml) fullTextContent += `\n\nPage Content:\n${cleanedHtml}`;
        fullTextContent = fullTextContent.trim();
        if (!fullTextContent) { console.warn(`Skipping ${inputFile}: No text content.`); return; }

        const imageSonnetPromise = processOriginalImage(originalImageUrl);
        const textChunks = [];
        for (let i = 0; i < fullTextContent.length; i += MAX_CHUNK_SIZE_CHARS) textChunks.push(fullTextContent.substring(i, i + MAX_CHUNK_SIZE_CHARS));
        if (textChunks.length === 0 && fullTextContent.length > 0) textChunks.push(fullTextContent);
        console.log(`Split into ${textChunks.length} chunks.`);
        if (textChunks.length === 0) { console.warn(`Skipping ${inputFile}: No chunks from content.`); return; }

        const textApiPromises = textChunks.map((chunk, idx) => {
            const userPrompt = selectedPrompt.chat.replace('[[chunk]]', chunk);
            const fullApiPrompt = `${selectedPrompt.system}\n\n${userPrompt}`;
            return textModel.generateContent({
                contents: [{ role: "user", parts: [{ text: fullApiPrompt }] }],
                generationConfig: { maxOutputTokens: 8192, temperature: 1.0 }, tools: [{ googleSearch: {} }]
            }).catch(err => ({ error: true, message: err.message, feedback: err.promptFeedback }));
        });
        const [imageSonnetResult, ...textApiResults] = await Promise.all([imageSonnetPromise, ...textApiPromises]);

        let combinedVerseOutput = "", toc = "## Table of Contents\n";
        const extractedImagePrompts = [];
        const extractedVideoPrompts = [];
        const firstVerseContentForTTS = { text: "" }; // Keep for fallback if no last verse

        textApiResults.forEach((result, index) => {
            const chunkNum = index + 1;
            if (result.error) { combinedVerseOutput += `<h3 id="v${chunkNum}">Verse ${chunkNum}</h3><p><em>Error: ${result.message}</em></p>\n`; return; }
            const messageContent = result.response?.text?.()?.trim();
            if (!messageContent) { combinedVerseOutput += `<h3 id="v${chunkNum}">Verse ${chunkNum}</h3><p><em>No content.</em></p>\n`; return; }
            const sections = { verse: '', image: '', video: '' }; let current = 'verse';
            messageContent.split('\n').forEach(line => {
                if (/^###\s*Image Prompt\s*$/i.test(line)) current = 'image';
                else if (/^###\s*Video Prompt\s*$/i.test(line)) current = 'video';
                else if (/^###\s*Verse\s*(\d*)\s*$/i.test(line)) current = 'verse';
                else if (sections[current] !== undefined) sections[current] += line + '\n';
            });
            Object.keys(sections).forEach(k => sections[k] = sections[k]?.trim() ?? '');
            const verse = sections.verse || messageContent;
            // Capture first verse for potential fallback TTS, if needed
            if (index === 0 && verse && !firstVerseContentForTTS.text) firstVerseContentForTTS.text = verse.split('\n').slice(0,5).join('\n');
            toc += `- [Verse ${chunkNum}](#v${chunkNum})\n`;
            if (sections.image) {
                toc += `  - [Img Prompt ${chunkNum}](#img-p${chunkNum})\n`;
                extractedImagePrompts.push(sections.image);
            }
            if (sections.video) {
                toc += `  - [Video Prompt ${chunkNum}](#video-p${chunkNum})\n`;
                extractedVideoPrompts.push(sections.video);
            }
            combinedVerseOutput += `<h3 id="v${chunkNum}">Verse ${chunkNum}</h3><div>${escapeHtml(verse).replace(/\n/g,'<br>')}</div>\n`;
            if (sections.image) combinedVerseOutput += `<h4 id="img-p${chunkNum}">Img Prompt ${chunkNum}</h4><pre><code>${escapeHtml(sections.image)}</code></pre>\n`;
            if (sections.video) combinedVerseOutput += `<h4 id="video-p${chunkNum}">Video Prompt ${chunkNum}</h4><pre><code>${escapeHtml(sections.video)}</code></pre>\n`;
        });

        let figureWithGeneratedImage = "<!-- No image prompts found or image generation not attempted -->";
        let promptUsedForImage = null;
        if (extractedImagePrompts.length > 0) {
            promptUsedForImage = extractedImagePrompts[Math.floor(Math.random() * extractedImagePrompts.length)];
            const imgGenRes = await generateAndEmbedImage(promptUsedForImage, baseFilename);

            const displayedImagePrompt = promptUsedForImage;

            if (imgGenRes.success) {
                 figureWithGeneratedImage = `### Generated Image\n${imgGenRes.markdown.trim()}\n*Prompt:*\n<pre><code class="language-text">${escapeHtml(displayedImagePrompt)}</code></pre>`;
            } else {
                let errorDisplay = `<p><strong>Image Generation Failed.</strong></p>`;
                errorDisplay += `<p><em>Error Summary:</em> ${escapeHtml(imgGenRes.error || 'Unknown error')}</p>`;
                if (imgGenRes.refusalReason) {
                    errorDisplay += `\n<p><em>Model's Explanation:</em></p>\n<pre><code class="language-text">${escapeHtml(imgGenRes.refusalReason)}</code></pre>\n`;
                }
                errorDisplay += `\n<p><em>Attempted prompt:</em></p>\n<pre><code class="language-text">${escapeHtml(displayedImagePrompt)}</code></pre>`;

                // ADDED: Detailed error information block
                if (imgGenRes.detailedErrorInfo) {
                    errorDisplay += `\n<details><summary>Click for Detailed Error JSON</summary>\n<pre><code class="language-json">${escapeHtml(JSON.stringify(imgGenRes.detailedErrorInfo, null, 2))}</code></pre>\n</details>\n`;
                }

                figureWithGeneratedImage = `### Generated Image\n${errorDisplay}`;
            }
        }

        let figureWithSelectedVideoPrompt = "<!-- No video prompts found -->";
        if (extractedVideoPrompts.length > 0) {
            const randomIndex = Math.floor(Math.random() * extractedVideoPrompts.length);
            const selectedVideoPrompt = extractedVideoPrompts[randomIndex];
            figureWithSelectedVideoPrompt = `
### Selected Video Prompt
<pre><code class="language-text">${escapeHtml(selectedVideoPrompt)}</code></pre>
*Note: This is an extracted prompt for potential future video generation. Actual video generation is not performed by this script.*
`;
        }

        let figureWithGeneratedAudio = "";
        let textToSynthesize = "";
        let originalTextForTTSDisplay = ""; // This will hold the exact text sent to TTS for display

        let lastVerseContent = "";
        const allVerseBlocks = [...combinedVerseOutput.matchAll(/<h3 id="v\d+">Verse \d+<\/h3><div>(.*?)<\/div>/gs)];

        if (allVerseBlocks.length > 0) {
            // The last match is at the end of the array, the content is in the first capturing group.
            lastVerseContent = allVerseBlocks[allVerseBlocks.length - 1][1];
            console.log(`[TTS DEBUG] Extracted lastVerseContent (raw, first 200 chars): "${lastVerseContent.substring(0, 200)}..." (length: ${lastVerseContent.length})`);
        } else {
            console.log("[TTS DEBUG] No verse blocks found in combinedVerseOutput.");
        }

        if (lastVerseContent) {
            let cleanedText = cleanTextForTTS(lastVerseContent);
            console.log(`[TTS DEBUG] Cleaned text after cleanTextForTTS (first 200 chars): "${cleanedText.substring(0, 200)}..." (length: ${cleanedText.length})`);

            const SLICE_BUFFER_CHARS = 100; // Extra chars to look for a good start
            const TARGET_TTS_LENGTH = 500; // Aim for this many characters for TTS
            const MIN_TTS_LENGTH = 50; // Minimum length required for TTS to attempt synthesis

            let candidateForTTS = cleanedText;

            // If the cleaned text is long enough to consider slicing and aligning
            if (cleanedText.length > TARGET_TTS_LENGTH) {
                // Take a chunk from the end that's our target length + a buffer
                let tempSlice = cleanedText.slice(Math.max(0, cleanedText.length - (TARGET_TTS_LENGTH + SLICE_BUFFER_CHARS)));
                console.log(`[TTS DEBUG] tempSlice (length: ${tempSlice.length}, first 100 chars): "${tempSlice.substring(0, 100)}..."`);

                // Find the first space in tempSlice to ensure we start on a word boundary
                const firstSpaceIndex = tempSlice.indexOf(' ');
                if (firstSpaceIndex !== -1) { // If a space is found, trim to start after it
                    candidateForTTS = tempSlice.substring(firstSpaceIndex + 1);
                    console.log(`[TTS DEBUG] candidateForTTS (after word boundary adjustment, first 100 chars): "${candidateForTTS.substring(0, 100)}..." (length: ${candidateForTTS.length})`);
                } else {
                    // If no space in tempSlice (e.g., it's a single long word or very short), just use tempSlice as is.
                    candidateForTTS = tempSlice;
                    console.log(`[TTS DEBUG] candidateForTTS (no space found in tempSlice, using as is, first 100 chars): "${candidateForTTS.substring(0, 100)}..." (length: ${candidateForTTS.length})`);
                }
            } else {
                console.log(`[TTS DEBUG] Cleaned text length (${cleanedText.length}) <= TARGET_TTS_LENGTH. Using full cleaned text as candidate.`);
            }
            
            // Final truncation to MAX_TTS_CHARS
            if (candidateForTTS.length > MAX_TTS_CHARS) {
                candidateForTTS = candidateForTTS.substring(0, MAX_TTS_CHARS);
                console.log(`[TTS DEBUG] Candidate truncated to MAX_TTS_CHARS (first 100 chars): "${candidateForTTS.substring(0, 100)}..." (length: ${candidateForTTS.length})`);
            }

            textToSynthesize = candidateForTTS;
            originalTextForTTSDisplay = textToSynthesize;

            // Check if the final text is too short for TTS
            if (textToSynthesize.length < MIN_TTS_LENGTH) {
                console.warn(`[TTS WARNING] Final text for TTS is too short (length: ${textToSynthesize.length}). Skipping audio generation.`);
                textToSynthesize = ""; // Clear it so TTS is skipped
            } else {
                console.log(`[TTS DEBUG] Final textToSynthesize for TTS (length: ${textToSynthesize.length}, first 100 chars): "${textToSynthesize.substring(0, 100)}..."`);
                console.log("TTS: Using cleaned last verse snippet for audio.");
            }
        } else {
            console.log("[TTS DEBUG] lastVerseContent was empty or not found, falling back to original logic.");
            // Fallback to previous logic if no last verse content found
            let fallbackCandidateText = promptUsedForImage || firstVerseContentForTTS.text;
            if (fallbackCandidateText) {
                console.log(`[TTS DEBUG] Fallback candidate text (raw, first 200 chars): "${fallbackCandidateText.substring(0, 200)}..."`);
                let cleanedFallbackText = cleanTextForTTS(fallbackCandidateText); // Use the full cleanTextForTTS
                textToSynthesize = cleanedFallbackText.substring(0, MAX_TTS_CHARS);
                originalTextForTTSDisplay = textToSynthesize; // Use the exact text for display
                console.log(`[TTS DEBUG] Final fallback textToSynthesize (length: ${textToSynthesize.length}, first 100 chars): "${textToSynthesize.substring(0, 100)}..."`);

                const MIN_FALLBACK_TTS_LENGTH = 50; // A minimum for fallback too
                if (textToSynthesize.length < MIN_FALLBACK_TTS_LENGTH) {
                     console.warn(`[TTS WARNING] Final fallback text for TTS is too short (length: ${textToSynthesize.length}). Skipping audio generation.`);
                     textToSynthesize = ""; // Clear it so TTS is skipped
                } else {
                     console.log(promptUsedForImage ? "TTS: Fallback to image prompt for audio." : "TTS: Fallback to first verse snippet for audio.");
                }
            } else {
                console.log("[TTS DEBUG] Fallback candidate text also empty. TTS will be skipped.");
            }
        }

        if (textToSynthesize) {
            const audioGenResult = await generateAndEmbedAudio(textToSynthesize, baseFilename, originalTextForTTSDisplay);
            figureWithGeneratedAudio = audioGenResult.markdown;
            if (!audioGenResult.success) console.error(`TTS: Failed to generate audio: ${audioGenResult.error}`);
        } else {
            console.log("TTS: No suitable text found for TTS. Skipping audio generation.");
            figureWithGeneratedAudio = "<!-- No suitable text for TTS -->";
        }

        const promptHash = generatePromptHash(selectedPrompt.system + selectedPrompt.chat);
        const safeTitle = (inputData.ogResult.ogTitle || baseFilename).replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/\s+/g, '_').substring(0, 50);
        const modelNameClean = TEXT_MODEL_NAME.replace(/[^a-zA-Z0-9.-]/g, '');
        const outputFilename = `${safeTitle}-${modelNameClean}-${promptHash}.md`;
        const outputPath = path.join(OUTPUT_POSTS_DIR, outputFilename);
        const relJsonPath = `/${path.basename(JSON_COPY_DIR)}/${inputFile}`.replace(/\\/g, '/');
        const mdOutput = `---
title: "${escapeHtml(inputData.ogResult.ogTitle || 'Untitled')}-${modelNameClean}-${selectedPrompt.name}"
author: Gemini
---
Source: [${inputData.ogResult.ogUrl || 'N/A'}](${inputData.ogResult.ogUrl || '#'})
${toc}<hr>${combinedVerseOutput}<hr>${imageSonnetResult}<hr>

${figureWithGeneratedImage}

<hr>
${figureWithSelectedVideoPrompt}

<hr>
### Generated Audio
*TTS Voice: ${escapeHtml(selectedTtsVoice)}*
${figureWithGeneratedAudio}<hr>

### Generation Details
<details><summary>Models & Prompt</summary>
<p><strong>Text:</strong> ${TEXT_MODEL_NAME}<br><strong>Vision:</strong> ${VISION_MODEL_NAME}<br><strong>Image Gen:</strong> ${IMAGE_GEN_MODEL_NAME}<br><strong>TTS:</strong> ${TTS_MODEL_DISPLAY_NAME}</p>
<p><strong>Prompt (${selectedPrompt.name}):</strong></p><strong>System:</strong><pre><code>${escapeHtml(selectedPrompt.system)}</code></pre><strong>Chat:</strong><pre><code>${escapeHtml(selectedPrompt.chat)}</code></pre></details><hr>
<button onclick="window.open('/js${relJsonPath}', '_blank');">Load Input JSON</button>`;
        await fs.writeFile(outputPath, mdOutput);
        console.log(`Generated: ${outputPath}`);
    } catch (error) {
        console.error(`\n--- ERROR processing ${currentInputFile} ---`, error.stack || error);
    } finally { currentInputFile = ''; currentInputPath = ''; }
}

function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return unsafe == null ? '' : String(unsafe);
    return unsafe
         .replace(/&/g, "&")
         .replace(/</g, "<")
         .replace(/>/g, ">")
         .replace(/"/g, "\"")
         .replace(/'/g, "'");
}

function generatePromptHash(promptText, length = 8) {
    if (!promptText?.length) return 'noPrompt';
    let hash = 0;
    for (let i = 0; i < promptText.length; i++) { hash = ((hash << 5) - hash) + promptText.charCodeAt(i); hash |= 0; } // Convert to 32bit integer
    return Math.abs(hash).toString(16).padStart(length, '0').substring(0, length);
}

async function main() {
    console.log("Starting Gemini script with TTS and new Image Gen...");
    try {
        if (apiKey) {
            googleGenAIClient = new GoogleGenAI({ apiKey: apiKey }); // Initialize the @google/genAI client
            console.log("GoogleGenAI Client (for TTS & Image Gen) initialized using @google/genAI.");
        } else {
            console.error("GoogleGenAI Client NOT initialized: API_KEY missing. TTS & Image Gen will fail.");
        }

        await fs.mkdir(OUTPUT_POSTS_DIR, { recursive: true });
        await fs.mkdir(OUTPUT_IMAGES_DIR, { recursive: true });
        await fs.mkdir(JSON_COPY_DIR, { recursive: true });

        await loadAndPreparePrompts();
        if (availablePrompts.length === 0) { console.error("FATAL: No prompts. Exiting."); process.exit(1); }

        const promptIdx = getNextPromptIndexSync();
        const selPrompt = availablePrompts[promptIdx];
        console.log(`Selected prompt: ${selPrompt.name} (Index: ${promptIdx})`);
        setPromptIndexSync(promptIdx);

        const files = await fs.readdir(INPUT_DATA_DIR).catch(err => {
            if (err.code === 'ENOENT') { console.error(`Input dir ${INPUT_DATA_DIR} not found.`); process.exit(1); }
            throw err;
        });
        const jsonFiles = files.filter(f => path.extname(f).toLowerCase() === '.json');
        if (jsonFiles.length === 0) { console.log(`No JSON files in ${INPUT_DATA_DIR}.`); return; }
        console.log(`Found ${jsonFiles.length} JSON files.`);

        for (const file of jsonFiles) {
            await new Promise(resolve => setTimeout(resolve, 500)); // Small delay
            await processSingleFile(file, selPrompt);
        }
        console.log("\n--- Script finished ---");
    } catch (error) {
        console.error("\n--- FATAL ERROR ---", error.stack || error);
        process.exit(1);
    }
}

main();

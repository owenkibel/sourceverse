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

const TEXT_MODEL_NAME = "gemini-2.5-flash-lite-preview-06-17";
const IMAGE_GEN_MODEL_NAME = "gemini-2.0-flash-preview-image-generation"; // Updated model name
const VISION_MODEL_NAME = "gemini-2.5-flash-lite-preview-06-17";

const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

let textModel, visionModel; // imageGenModel removed
let googleGenAIClient; // Renamed from ttsAI, will be used for TTS and Image Gen
let logMessage; // ADDED: For FFMPEG logging messages

try {
    textModel = genAI.getGenerativeModel({ model: TEXT_MODEL_NAME, safetySettings });
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
        return { success: false, error: "Image generation client not initialized.", markdown: "<!-- Image generation skipped: Client not initialized -->", refusalReason: null, detailedErrorInfo: { message: "GoogleGenAI client not initialized." } };
    }
    if (!imagePromptContent || typeof imagePromptContent !== 'string' || imagePromptContent.trim().length === 0) {
         console.warn("Skipping image generation: Received empty or invalid prompt.");
         return { success: false, error: "No valid prompt provided for image generation.", markdown: "<!-- Image generation skipped: No valid prompt provided -->", refusalReason: null, detailedErrorInfo: { message: "No valid prompt provided for image generation." } };
    }
    const trimmedPrompt = imagePromptContent.trim();
    console.log(`Generating image with prompt: "${trimmedPrompt.substring(0, 150)}..." (using ${IMAGE_GEN_MODEL_NAME})`);
    try {
        const apiResponse = await googleGenAIClient.models.generateContent({
            model: IMAGE_GEN_MODEL_NAME,
            contents: trimmedPrompt,
            safetySettings: safetySettings,
            config: { responseModalities: [Modality.TEXT, Modality.IMAGE] },
        });
        if (!apiResponse || !apiResponse.candidates || apiResponse.candidates.length === 0) {
            const blockReasonFromFeedback = apiResponse?.promptFeedback?.blockReason || 'N/A';
            const errorMsg = `Image generation failed: No candidates returned from API. Block Reason: ${blockReasonFromFeedback}`;
            console.error(errorMsg, "Prompt Feedback:", apiResponse?.promptFeedback);
            return { success: false, error: errorMsg, markdown: `<!-- ${escapeHtml(errorMsg)} -->`, refusalReason: `API Error: No candidates. Block Reason from promptFeedback: ${blockReasonFromFeedback}`, detailedErrorInfo: { type: "NoCandidatesReturned", promptFeedback: apiResponse?.promptFeedback || null, fullApiResponseCandidateCount: apiResponse?.candidates?.length || 0, } };
        }
        const candidate = apiResponse.candidates[0];
        let refusalText = null;
        let imagePartPayload = null;
        const filteredContentParts = candidate.content?.parts?.map(part => {
            if (part.inlineData) { return { inlineData: { mimeType: part.inlineData.mimeType, dataLength: part.inlineData.data?.length || 0, note: "Base64 data omitted for brevity" } }; }
            else if (part.fileData) { return { fileData: { mimeType: part.fileData.mimeType, fileUri: part.fileData.fileUri, note: "File URI data" } }; }
            return part;
        }) || null;
        if (candidate.content && candidate.content.parts) {
            for (const part of candidate.content.parts) {
                if (part.text) { refusalText = part.text; }
                else if (part.inlineData && part.inlineData.mimeType?.startsWith('image/')) { imagePartPayload = part.inlineData; }
                else if (part.fileData && part.fileData.mimeType?.startsWith('image/')) { if (!imagePartPayload) imagePartPayload = part.fileData; }
            }
        }
        if (refusalText && !imagePartPayload) {
            const finishReason = candidate.finishReason || 'N/A';
            const safetyRatingsString = candidate.safetyRatings ? JSON.stringify(candidate.safetyRatings) : 'N/A';
            console.warn(`Image generation model returned a text response (policy refusal): "${refusalText.substring(0, 200)}..." Finish Reason: ${finishReason}`);
            return { success: false, error: `Image generation refused by model policy. Finish Reason: ${finishReason}. Safety: ${safetyRatingsString}`, markdown: `<!-- Image Generation Refused by Model Policy. Finish Reason: ${escapeHtml(finishReason)}. Safety: ${escapeHtml(safetyRatingsString)} -->`, refusalReason: refusalText, detailedErrorInfo: { type: "ModelPolicyRefusal", candidateFinishReason: candidate?.finishReason || null, candidateSafetyRatings: candidate?.safetyRatings || null, promptFeedback: apiResponse?.promptFeedback || null, filteredCandidateContentParts: filteredContentParts } };
        }
        if (!imagePartPayload) {
            const blockReason = apiResponse.promptFeedback?.blockReason || candidate.finishReason || 'Unknown reason';
            const safetyRatingsString = candidate.safetyRatings ? JSON.stringify(candidate.safetyRatings) : 'N/A';
            const errorMsg = `Image generation failed: No image data found in response parts. Reason: ${blockReason}. Safety: ${safetyRatingsString}`;
            console.error(errorMsg, "Full Candidate (condensed):", { finishReason: candidate.finishReason, safetyRatings: candidate.safetyRatings }, "Prompt Feedback:", apiResponse.promptFeedback);
            return { success: false, error: errorMsg, markdown: `<!-- Image Generation Failed: No image data. Reason: ${escapeHtml(blockReason)}. Safety: ${escapeHtml(safetyRatingsString)} -->`, refusalReason: `Model Error: No image data. Reason: ${blockReason}. Safety Ratings: ${safetyRatingsString}`, detailedErrorInfo: { type: "NoImageDataInResponse", promptFeedback: apiResponse?.promptFeedback || null, candidateFinishReason: candidate?.finishReason || null, candidateSafetyRatings: candidate?.safetyRatings || null, filteredCandidateContentParts: filteredContentParts } };
        }
        let imageDataBuffer;
        let imageExt = '.png';
        if (imagePartPayload.data) {
            imageDataBuffer = Buffer.from(imagePartPayload.data, 'base64');
            const mimeType = imagePartPayload.mimeType;
            if (mimeType === 'image/jpeg') imageExt = '.jpg';
            else if (mimeType === 'image/webp') imageExt = '.webp';
            else imageExt = `.${mimeType.split('/')[1] || 'png'}`;
        } else if (imagePartPayload.fileUri) {
             const errorMsg = `Image generation returned a file URI (${imagePartPayload.fileUri}), which requires separate download logic not implemented. Expected inline image data.`;
             console.error(errorMsg);
             return { success: false, error: errorMsg, markdown: `<!-- Image Generation Failed: ${escapeHtml(errorMsg)} -->`, refusalReason: errorMsg, detailedErrorInfo: { type: "FileURIUnsupported", fileUri: imagePartPayload.fileUri } };
        } else { throw new Error("Unrecognized image data format in Gemini response part."); }
        const imageName = `gemini-img-${Date.now()}-${baseFilename}${imageExt}`;
        const imagePath = path.join(OUTPUT_IMAGES_DIR, imageName);
        const relativeImagePathForMarkdown = `/${path.basename(OUTPUT_IMAGES_DIR)}/${imageName}`.replace(/\\/g, '/');
        await fs.writeFile(imagePath, imageDataBuffer);
        console.log(`Image successfully saved as ${imagePath}`);
        // The markdown already includes the leading/trailing newlines.
        return { success: true, markdown: `\n\n![Generated Image](${relativeImagePathForMarkdown})\n\n`, refusalReason: null, detailedErrorInfo: null };
    } catch (error) {
        console.error(`Error in generateAndEmbedImage for prompt "${trimmedPrompt.substring(0,100)}...":`, error.message, error.stack);
        let detailedError = error.message;
        let errorDetailsForOutput = {};
        if (error.status && error.details) {
            detailedError = `API Error (Status ${error.status}): ${error.message}. Details: ${JSON.stringify(error.details)}`;
            errorDetailsForOutput = { type: "APIException", status: error.status, message: error.message, details: error.details, name: error.name };
        } else if (error.response && error.response.data) {
            detailedError = `API Error: ${JSON.stringify(error.response.data)}`;
            errorDetailsForOutput = { type: "AxiosResponseError", data: error.response.data, status: error.response.status };
        } else {
            errorDetailsForOutput = { type: "GeneralException", message: error.message, stack: error.stack, name: error.name };
        }
        return { success: false, error: detailedError, markdown: `\n\n<!-- Image Generation Exception: ${escapeHtml(detailedError)} -->\n\n`, refusalReason: `Exception during image generation: ${detailedError}`, detailedErrorInfo: errorDetailsForOutput };
    }
}

/**
 * Encodes PCM audio buffer to WebM Opus format, with optional audio enhancements.
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
            `-ar ${inputSampleRate}`,
            `-ac ${inputChannels}`
        ]);

      let finalOutputChannels = inputChannels;
      let filterGraph = [];
      let currentAudioStreamLabel = '[0:a]'; // Input stream label

      // If input is mono and effect needs stereo, create a basic stereo stream first.
      // This is a common pattern to ensure effects have left/right channels to work with.
      const needsStereo = ['pseudoStereo', 'pingPongEcho'].includes(audioEnhancement.type);
      if (inputChannels === 1 && needsStereo) {
          // asplit to duplicate mono to two identical mono streams, then amerge to stereo
          filterGraph.push(`${currentAudioStreamLabel}asplit[l][r]`);
          filterGraph.push(`[l][r]amerge=inputs=2[stereo_pre_effect]`);
          currentAudioStreamLabel = '[stereo_pre_effect]';
          finalOutputChannels = 2;
      } else if (inputChannels >= 2) {
          finalOutputChannels = 2; // Assume stereo output for effects, if input is already stereo
      }

      switch (audioEnhancement.type) {
        case 'pseudoStereo':
            // Simple stereo widening by delaying one channel. Assumes stereo input.
            // If original was mono, it's now a basic stereo stream from 'stereo_pre_effect'.
            const delayMs = audioEnhancement.delayMs || 25;
            filterGraph.push(`${currentAudioStreamLabel}channelsplit=channel_layout=stereo[L][R]`);
            filterGraph.push(`[R]adelay=${delayMs}|${delayMs}[Rd]`); // Delay the right channel
            filterGraph.push(`[L][Rd]amerge=inputs=2[aout]`);
            currentAudioStreamLabel = '[aout]';
            logMessage = `FFMPEG: Pseudo-stereo audio encoded to ${outputFilename}`;
            break;
        
        case 'pingPongEcho':
            // True ping-pong echo: Sound bounces between left and right channels.
            // Assumes mono input from TTS, creates stereo output.
            const pingPongDelay = audioEnhancement.delayMs || 400; // ms
            const pingPongDecay = audioEnhancement.decay || 0.6; // 60% volume decay per bounce

            // The 'currentAudioStreamLabel' is the mono source from TTS.
            // Use asplit to create multiple mono branches from the single source.
            filterGraph.push(`${currentAudioStreamLabel}asplit=4[orig][delay1_src][delay2_src][delay3_src]`);

            // Direct sound: From 'orig' stream, goes primarily to the left channel.
            filterGraph.push(`[orig]pan=stereo|c0=c0|c1=0.1*c0[L_direct]`); // Original sound mostly on Left

            // First bounce: From 'delay1_src', delayed, goes primarily to the right channel.
            filterGraph.push(`[delay1_src]adelay=${pingPongDelay}[d1]`);
            filterGraph.push(`[d1]volume=${pingPongDecay}[v1]`);
            filterGraph.push(`[v1]pan=stereo|c0=0.1*c0|c1=c0[R_bounce1]`); // First echo mostly on Right

            // Second bounce: From 'delay2_src', more delayed, goes primarily to the left channel.
            filterGraph.push(`[delay2_src]adelay=${2 * pingPongDelay}[d2]`);
            filterGraph.push(`[d2]volume=${pingPongDecay * pingPongDecay}[v2]`);
            filterGraph.push(`[v2]pan=stereo|c0=c0|c1=0.1*c0[L_bounce2]`); // Second echo mostly on Left

            // Third bounce: From 'delay3_src', even more delayed, goes primarily to the right channel.
            filterGraph.push(`[delay3_src]adelay=${3 * pingPongDelay}[d3]`);
            filterGraph.push(`[d3]volume=${pingPongDecay * pingPongDecay * pingPongDecay}[v3]`);
            filterGraph.push(`[v3]pan=stereo|c0=0.1*c0|c1=c0[R_bounce3]`); // Third echo mostly on Right

            // Mix all the individual stereo streams together.
            // REMOVED `dropout_mode=resampler` for broader FFmpeg version compatibility
            filterGraph.push(`[L_direct][R_bounce1][L_bounce2][R_bounce3]amix=inputs=4[aout]`);
            currentAudioStreamLabel = '[aout]';
            finalOutputChannels = 2; // Output will always be stereo for this effect
            logMessage = `FFMPEG: True ping-pong stereo echo applied to ${outputFilename}`;
            break;

        // No 'convolver' case, as per instructions.
      }

      if (filterGraph.length > 0) {
          command.complexFilter(filterGraph.join('; '));
          command.outputOptions([`-map ${currentAudioStreamLabel}`]);
      }
      
      command.audioChannels(finalOutputChannels);

      if (outputSampleRate && outputSampleRate !== inputSampleRate) {
          command.audioFrequency(outputSampleRate);
          logMessage += ` (resampled to ${outputSampleRate}Hz)`;
      }

      command.audioCodec('libopus').format('webm').save(outputFilename)
         .on('end', () => { console.log(`${logMessage}\nFFMPEG: Audio successfully encoded to ${outputFilename}`); resolve(`File saved as ${outputFilename}`); })
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
        const ttsSpecificConfig = { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedTtsVoice } } } };
        const result = await googleGenAIClient.models.generateContent({ model: TTS_MODEL_NAME_FOR_API, contents: [{ role: "user", parts: [{ text: cleanTtsText }] }], safetySettings: safetySettings, config: ttsSpecificConfig });
        const audioDataPart = result.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (!audioDataPart) {
             let errorDetails = "No audio data in response.";
             if (result.candidates && result.candidates.length > 0) { errorDetails += ` Candidate: ${JSON.stringify(result.candidates[0])}`; }
             else if (result.promptFeedback) { errorDetails += ` Prompt Feedback: ${JSON.stringify(result.promptFeedback)}`; }
             else { errorDetails += ` Full Response: ${JSON.stringify(result)}`; }
             throw new Error(errorDetails);
        }
        const pcmAudioBuffer = Buffer.from(audioDataPart, 'base64');
        const audioName = `gemini-tts-${Date.now()}-${baseFilename}.webm`;
        const audioPath = path.join(OUTPUT_IMAGES_DIR, audioName);
        console.log(`Encoding PCM audio (size: ${pcmAudioBuffer.length}) to ${audioPath}...`);
        
        const inputSampleRateFromTTS = 24000;
        const inputChannelsFromTTS = 1;
        const inputSampleFormatFromTTS = 's16le';

        // --- Select Audio Enhancement Option ---
        // Uncomment one of the following options:

        // OPTION 1: Ping-Pong Echo (Default)
        await encodePcmToWebmOpus(
            audioPath, pcmAudioBuffer, inputChannelsFromTTS, inputSampleRateFromTTS, inputSampleFormatFromTTS,
            { audioEnhancement: { type: 'pingPongEcho', delayMs: 400, decay: 0.6 }, outputSampleRate: 48000 }
        );

        // OPTION 2: Pseudo-Stereo / Stereo Widening
        /*
        await encodePcmToWebmOpus(
            audioPath, pcmAudioBuffer, inputChannelsFromTTS, inputSampleRateFromTTS, inputSampleFormatFromTTS,
            { audioEnhancement: { type: 'pseudoStereo', delayMs: 25 }, outputSampleRate: 48000 }
        );
        */

        // OPTION 3: No Audio Enhancement (Plain Stereo WebM Opus)
        /*
        await encodePcmToWebmOpus(
            audioPath, pcmAudioBuffer, inputChannelsFromTTS, inputSampleRateFromTTS, inputSampleFormatFromTTS,
            { audioEnhancement: { type: 'none' }, outputSampleRate: 48000 } // Often 48k is good for web
        );
        */

        const markdown = `\n<audio controls src="/${path.basename(OUTPUT_IMAGES_DIR)}/${audioName}"></audio>\n*Audio from text:*\n<pre><code class="language-text">${escapeHtml(sourcePromptText)}</code></pre>`;
        return { success: true, markdown: markdown.trim(), audioFilePath: audioPath };
    } catch (error) {
        console.error(`Audio gen error for "${cleanTtsText.substring(0,100)}...":`, error.message, error.stack);
        const failureMarkdown = `\n<p><strong>Audio generation failed.</strong> Error: ${escapeHtml(error.message)}</p>\n` +
                                `*Attempted text for audio:*\n<pre><code class="language-text">${escapeHtml(sourcePromptText)}</code></pre>`;
        return { success: false, error: error.message, markdown: failureMarkdown };
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
        const ext = path.extname(new URL(imageUrl).pathname).toLowerCase(); // Corrected for URL query params
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

// ADDED: Function to analyze YouTube audio
async function analyzeYouTubeAudio(youtubeUrl) {
    console.log(`Analyzing YouTube audio from: ${youtubeUrl}`);
    const prompt = `
Analyze the audio from the provided video and perform two distinct tasks. Format the entire response as plain text without any surrounding markdown.

### Music Generation Prompt
Generate a comma-delimited list of keywords suitable for an AI music generation model. The list should describe the music's most prominent characteristics.
- Start with the most generic and important terms (e.g., genre, mood, era) and progress to more specific details (e.g., specific instruments, vocal style).
- Do NOT use category labels like "Style:", "Tempo:", "Instruments:", etc.
- The entire output for this section must be a single line of text containing only the keywords separated by commas.
- Example: cinematic, orchestral, epic, dramatic, fast-tempo, strings, brass, timpani, choral.

### Transcript
Transcribe all spoken words and song lyrics from the audio.
- If multiple speakers are present, attempt to identify and differentiate them.
- Assign each speaker an inferred name based on the video's context (e.g., "Narrator", "David Attenborough") or a generic but consistent label (e.g., "Interviewer", "Female Voice", "Speaker 1").
- Format the transcript with the speaker's name or label before their lines.
- If no speech or lyrics are detected, state "No speech or lyrics detected."
  `;
    try {
        // fileData requires a direct URL which the model can access, and a mimeType
        const result = await textModel.generateContent([ prompt, { fileData: { fileUri: youtubeUrl, mimeType: "video/mp4" } } ]);
        const analysisText = result.response.text();
        return { success: true, markdown: `\n### YouTube Audio Analysis\n<pre><code>${escapeHtml(analysisText)}</code></pre>\n` };
    } catch (error) {
        console.error(`An error occurred during YouTube audio analysis for ${youtubeUrl}:`, error);
        return { success: false, error: error.message };
    }
}

// ADDED: Function to unescape HTML entities
function unescapeHtml(text) {
    if (typeof text !== 'string') return text == null ? '' : String(text);
    return text.replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">").replace(/"/g, "\"").replace(/'/g, "'").replace(/ /g, ' ');
}

// ADDED: Function to clean text for TTS
function cleanTextForTTS(text) {
    if (typeof text !== 'string') return '';
    let cleaned = unescapeHtml(text);
    cleaned = cleaned.replace(/<[^>]+>/g, ' ');
    cleaned = cleaned.replace(/[\*_#`\[\]\(\)]/g, '');
    cleaned = cleaned.replace(/\.{3,}/g, '. ');
    cleaned = cleaned.replace(/[\r\n]+/g, ' ');
    const allowedPunctuation = `.,!?;:'"-/`;
    const regexForNonAlphaNumericNonAllowedPunctuation = new RegExp(`[^a-zA-Z0-9${allowedPunctuation}\\s]`, 'g');
    cleaned = cleaned.replace(regexForNonAlphaNumericNonAllowedPunctuation, '');
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
        let fullTextContent = [ inputData.ogResult?.ogUrl, inputData.ogResult?.ogTitle, inputData.ogResult?.ogDescription, inputData.youtube?.subtitles ].filter(Boolean).join('\n');
        const articleBody = inputData.ogResult.jsonLD?.find(item => item.articleBody)?.articleBody;
        if (articleBody) fullTextContent += `\n\n<blockquote cite="${inputData.ogResult?.ogUrl || ''}">JSON-LD:\n${escapeHtml(articleBody)}</blockquote>`;
        const cleanedHtml = (inputData.ogHTML || '').replace(/<style[^>]*>.*?<\/style>|<script[^>]*>.*?<\/script>|<[^>]+>/gis, ' ').replace(/\s{2,}/g, ' ').trim();
        if (cleanedHtml) fullTextContent += `\n\nPage Content:\n${cleanedHtml}`;
        fullTextContent = fullTextContent.trim();
        if (!fullTextContent) { console.warn(`Skipping ${inputFile}: No text content.`); return; }

        let youtubeAnalysisPromise = Promise.resolve(null); // Initialize with null promise
        const sourceUrl = inputData.ogResult.ogUrl;
        if (sourceUrl && (sourceUrl.includes('youtube.com/') || sourceUrl.includes('music.youtube.com/'))) {
            const cleanYoutubeUrl = sourceUrl.replace('music.youtube.com', 'youtube.com');
            youtubeAnalysisPromise = analyzeYouTubeAudio(cleanYoutubeUrl);
        }

        const textChunks = [];
        for (let i = 0; i < fullTextContent.length; i += MAX_CHUNK_SIZE_CHARS) textChunks.push(fullTextContent.substring(i, i + MAX_CHUNK_SIZE_CHARS));
        if (textChunks.length === 0 && fullTextContent.length > 0) textChunks.push(fullTextContent);
        if (textChunks.length === 0) { console.warn(`Skipping ${inputFile}: No chunks from content.`); return; }

        const textApiPromises = textChunks.map((chunk) => {
            const userPrompt = selectedPrompt.chat.replace('[[chunk]]', chunk);
            const fullApiPrompt = `${selectedPrompt.system}\n\n${userPrompt}`;
            return textModel.generateContent({ contents: [{ role: "user", parts: [{ text: fullApiPrompt }] }], generationConfig: { maxOutputTokens: 8192, temperature: 1.0 }, tools: [{ googleSearch: {} }] }).catch(err => ({ error: true, message: err.message, feedback: err.promptFeedback }));
        });

        // MODIFIED: Added youtubeAnalysisPromise to Promise.all
        const [imageSonnetResult, youtubeAnalysisResult, ...textApiResults] = await Promise.all([ processOriginalImage(originalImageUrl), youtubeAnalysisPromise, ...textApiPromises ]);

        let combinedVerseOutput = "", toc = "## Table of Contents\n";
        const extractedImagePrompts = [], extractedVideoPrompts = [], firstVerseContentForTTS = { text: "" };
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
            if (index === 0 && verse && !firstVerseContentForTTS.text) firstVerseContentForTTS.text = verse.split('\n').slice(0,5).join('\n');
            toc += `- [Verse ${chunkNum}](#v${chunkNum})\n`;
            if (sections.image) { toc += `  - [Img Prompt ${chunkNum}](#img-p${chunkNum})\n`; extractedImagePrompts.push(sections.image); }
            if (sections.video) { toc += `  - [Video Prompt ${chunkNum}](#video-p${chunkNum})\n`; extractedVideoPrompts.push(sections.video); }
            combinedVerseOutput += `<h3 id="v${chunkNum}">Verse ${chunkNum}</h3><div>${escapeHtml(verse).replace(/\n/g,'<br>')}</div>\n`;
            if (sections.image) combinedVerseOutput += `<h4 id="img-p${chunkNum}">Img Prompt ${chunkNum}</h4><pre><code>${escapeHtml(sections.image)}</code></pre>\n`;
            if (sections.video) combinedVerseOutput += `<h4 id="video-p${chunkNum}">Video Prompt ${chunkNum}</h4><pre><code>${escapeHtml(sections.video)}</code></pre>\n`;
        });
        let figureWithGeneratedImage = "<!-- No image prompts found or image generation not attempted -->";
        if (extractedImagePrompts.length > 0) {
            const promptUsedForImage = extractedImagePrompts[Math.floor(Math.random() * extractedImagePrompts.length)];
            const imgGenRes = await generateAndEmbedImage(promptUsedForImage, baseFilename);
            if (imgGenRes.success) {
                 // FIX: Removed .trim() here to preserve leading/trailing newlines
                 figureWithGeneratedImage = `### Generated Image\n${imgGenRes.markdown}\n*Prompt:*\n<pre><code class="language-text">${escapeHtml(promptUsedForImage)}</code></pre>`;
            } else {
                let errorDisplay = `<p><strong>Image Generation Failed.</strong></p><p><em>Error Summary:</em> ${escapeHtml(imgGenRes.error || 'Unknown error')}</p>`;
                if (imgGenRes.refusalReason) { errorDisplay += `\n<p><em>Model's Explanation:</em></p>\n<pre><code class="language-text">${escapeHtml(imgGenRes.refusalReason)}</code></pre>\n`; }
                errorDisplay += `\n<p><em>Attempted prompt:</em></p>\n<pre><code class="language-text">${escapeHtml(promptUsedForImage)}</code></pre>`;
                if (imgGenRes.detailedErrorInfo) { errorDisplay += `\n<details><summary>Click for Detailed Error JSON</summary>\n<pre><code class="language-json">${escapeHtml(JSON.stringify(imgGenRes.detailedErrorInfo, null, 2))}</code></pre>\n</details>\n`; }
                figureWithGeneratedImage = `### Generated Image\n${errorDisplay}`;
            }
        }
        let figureWithSelectedVideoPrompt = "<!-- No video prompts found -->";
        if (extractedVideoPrompts.length > 0) {
            const selectedVideoPrompt = extractedVideoPrompts[Math.floor(Math.random() * extractedVideoPrompts.length)];
            figureWithSelectedVideoPrompt = `\n### Selected Video Prompt\n<pre><code class="language-text">${escapeHtml(selectedVideoPrompt)}</code></pre>\n*Note: This is an extracted prompt for potential future video generation. Actual video generation is not performed by this script.*\n`;
        }

        // ADDED: YouTube audio analysis integration
        let youtubeAnalysisOutput = "<!-- Source was not a YouTube video -->";
        if (youtubeAnalysisResult) {
            if (youtubeAnalysisResult.success) { youtubeAnalysisOutput = youtubeAnalysisResult.markdown; }
            else { youtubeAnalysisOutput = `\n### YouTube Audio Analysis\n<p><strong>Audio analysis failed.</strong></p>\n<p><em>Error:</em> ${escapeHtml(youtubeAnalysisResult.error)}</p>\n`; }
        }

        // --- REFINED TTS TEXT SELECTION AND GENERATION LOGIC ---
        let figureWithGeneratedAudio = "<!-- No suitable text found for TTS -->";
        let textToSynthesize = "";
        let rawTextForTTS = "";

        const allVerseBlocks = [...combinedVerseOutput.matchAll(/<h3 id="v\d+">Verse \d+<\/h3><div>(.*?)<\/div>/gs)];
        let lastVerseContent = "";
        if (allVerseBlocks.length > 0) {
            lastVerseContent = allVerseBlocks[allVerseBlocks.length - 1][1];
        }

        if (lastVerseContent) {
            // Filter out analysis-like lines from the raw verse text.
            const verseOnlyText = lastVerseContent.split(/<br\s*\/?>/i)
                .filter(line => !/^\s*rhyme scheme|iambic pentameter|meter:|analysis:|style:/i.test(line.trim()))
                .join(' ');
            rawTextForTTS = cleanTextForTTS(verseOnlyText);
            console.log("TTS: Selected last verse snippet for audio.");
        } else {
            // Fallback if no last verse content found
            let fallbackCandidateText = extractedImagePrompts[0] || firstVerseContentForTTS.text;
            if (fallbackCandidateText) {
                // Apply the same filtering to the fallback text.
                const filteredFallbackText = fallbackCandidateText.split('\n')
                    .filter(line => !/^\s*rhyme scheme|iambic pentameter|meter:|analysis:|style:|prompt:/i.test(line.trim()))
                    .join(' ');
                rawTextForTTS = cleanTextForTTS(filteredFallbackText);
                console.log("TTS: Using fallback (image prompt or first verse) for audio.");
            }
        }

        if (rawTextForTTS) {
            const SLICE_BUFFER_CHARS = 100;
            const TARGET_TTS_LENGTH = 500;
            const MIN_TTS_LENGTH = 50;
            
            let candidateForTTS = rawTextForTTS;

            // If the cleaned text is long, try to slice a readable chunk from the end
            if (candidateForTTS.length > TARGET_TTS_LENGTH) {
                let tempSlice = candidateForTTS.slice(Math.max(0, candidateForTTS.length - (TARGET_TTS_LENGTH + SLICE_BUFFER_CHARS)));
                const firstSpaceIndex = tempSlice.indexOf(' ');
                candidateForTTS = (firstSpaceIndex !== -1) ? tempSlice.substring(firstSpaceIndex + 1) : tempSlice;
            }
            
            // Final truncation to the model's hard limit
            if (candidateForTTS.length > MAX_TTS_CHARS) {
                candidateForTTS = candidateForTTS.substring(0, MAX_TTS_CHARS);
            }
            
            textToSynthesize = candidateForTTS;

            if (textToSynthesize.length < MIN_TTS_LENGTH) {
                console.warn(`[TTS WARNING] Final text for TTS is too short (length: ${textToSynthesize.length}). Skipping audio generation.`);
                figureWithGeneratedAudio = `<p><strong>Audio generation skipped.</strong> Selected text was too short after processing.</p>\n` +
                                           `*Attempted text for audio:*\n<pre><code class="language-text">${escapeHtml(rawTextForTTS)}</code></pre>`;
                textToSynthesize = ""; // Ensure we don't try to generate
            }
        }
        
        if (textToSynthesize) {
            // Pass the final, processed text to the audio generator for both synthesis and display.
            const audioGenResult = await generateAndEmbedAudio(textToSynthesize, baseFilename, textToSynthesize);
            figureWithGeneratedAudio = audioGenResult.markdown;
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
${youtubeAnalysisOutput}
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
    return unsafe.replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">").replace(/"/g, "\"").replace(/'/g, "'");
}

function generatePromptHash(promptText, length = 8) {
    if (!promptText?.length) return 'noPrompt';
    let hash = 0;
    for (let i = 0; i < promptText.length; i++) { hash = ((hash << 5) - hash) + promptText.charCodeAt(i); hash |= 0; }
    return Math.abs(hash).toString(16).padStart(length, '0').substring(0, length);
}

async function main() {
    console.log("Starting Gemini script with TTS and new Image Gen...");
    try {
        if (apiKey) {
            googleGenAIClient = new GoogleGenAI({ apiKey: apiKey });
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
            await new Promise(resolve => setTimeout(resolve, 500));
            await processSingleFile(file, selPrompt);
        }
        console.log("\n--- Script finished ---");
    } catch (error) {
        console.error("\n--- FATAL ERROR ---", error.stack || error);
        process.exit(1);
    }
}

main();
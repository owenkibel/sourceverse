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
const { GoogleGenAI, Modality } = require('@google/genai');
const { createWriteStream } = require("fs");
const { Readable } = require("stream");
const TTS_MODEL_NAME_FOR_API = "gemini-2.5-flash-preview-tts";
const TTS_MODEL_DISPLAY_NAME = "Gemini TTS (gemini-2.5-flash-preview-tts, single speaker)";
const MAX_TTS_CHARS = 1000;

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

// This value is now set high to process long videos in a single chunk.
const MAX_CHUNK_TOKEN_ESTIMATE = 500000;
const AVG_CHARS_PER_TOKEN = 4;
const MAX_CHUNK_SIZE_CHARS = MAX_CHUNK_TOKEN_ESTIMATE * AVG_CHARS_PER_TOKEN;

const apiKey = process.env.API_KEY;
if (!apiKey) {
    console.error("FATAL: API_KEY environment variable for Google AI is not set.");
    process.exit(1);
}
const genAI = new GoogleGenerativeAI(apiKey);

const TEXT_MODEL_NAME = "gemini-2.5-flash";
const IMAGE_GEN_MODEL_NAME = "imagen-4.0-ultra-generate-001";
const VISION_MODEL_NAME = "gemini-2.5-flash";
const VEO_2_MODEL_NAME = "veo-2.0-generate-001";
const VEO_3_MODEL_NAME = "veo-3.0-generate-preview";

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
    // A single text model with a balanced temperature for mixed factual/creative tasks.
    textModel = genAI.getGenerativeModel({
        model: TEXT_MODEL_NAME,
        safetySettings,
        generationConfig: { temperature: 1 }
    });
    visionModel = genAI.getGenerativeModel({ model: VISION_MODEL_NAME, safetySettings });
    console.log(`Models initialized (via @google/generative-ai):`);
    console.log(`- Text Model (${TEXT_MODEL_NAME}, temp: 1)`);
    console.log(`- Vision Model (${VISION_MODEL_NAME})`);
    console.log(`Image Gen will use ${IMAGE_GEN_MODEL_NAME} (via @google/genai client).`);
    console.log(`Video Gen will default to ${VEO_3_MODEL_NAME} with a fallback to ${VEO_2_MODEL_NAME}.`);
} catch (modelError) {
    console.error("FATAL: Error initializing Google AI models (@google/generative-ai):", modelError.message);
    process.exit(1);
}

let currentInputFile = '';
let currentInputPath = '';
let availablePrompts = [];
let selectedTtsVoice = '';
let useLocalAudioProcessing = false;
let localAudioStartTime = '0';


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
            chatPrompt = chatPrompt.replace(/\[[poet]]/g, style); // Corrected this to replace [[poet]] not [[verseStyle]] again
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

async function generateAndEmbedVideoVeo2(videoPromptContent, baseFilename, imageInput = null) {
    if (imageInput) {
        console.warn("Veo 2 Fallback: Image input was provided but will be ignored, as this is not a supported feature for this model.");
    }
    const trimmedPrompt = videoPromptContent.trim();
    console.log(`Generating video with prompt: "${trimmedPrompt.substring(0, 150)}..." (using ${VEO_2_MODEL_NAME})`);
    try {
        let operation = await googleGenAIClient.models.generateVideos({
            model: VEO_2_MODEL_NAME,
            prompt: trimmedPrompt,
            config: {
                numberOfVideos: 1,
                durationSeconds: 8,
                personGeneration: "allow_all",
                aspectRatio: "16:9",
            },
        });

        while (!operation.done) {
            console.log("Waiting for Veo 2 generation to complete...");
            await new Promise((resolve) => setTimeout(resolve, 10000));
            operation = await googleGenAIClient.operations.getVideosOperation({ operation });
        }
        
        console.log("Veo 2 operation complete. Full response:", JSON.stringify(operation.response, null, 2));
        const generatedVideos = operation.response?.generatedVideos;

        if (!generatedVideos || generatedVideos.length === 0) {
            const refusalReason = operation.response?.promptFeedback?.blockReason || 'No video data or candidates were returned from the API.';
            const errorMsg = `Video generation failed: No videos were generated. Reason: ${refusalReason}`;
            console.error(errorMsg);
            return { success: false, error: errorMsg, markdown: `<!-- ${escapeHtml(errorMsg)} -->` };
        }

        let markdown = "";
        await Promise.all(generatedVideos.map(async (generatedVideo, i) => {
             if (!generatedVideo.video?.uri) {
                console.warn(`Skipping Veo 2 video index ${i}: No URI found.`);
                return;
            }
            const videoName = `gemini-video-veo2-${Date.now()}-${baseFilename}-${i}.mp4`;
            const videoPath = path.join(OUTPUT_IMAGES_DIR, videoName);
            const relativeVideoPathForMarkdown = `/${path.basename(OUTPUT_IMAGES_DIR)}/${videoName}`.replace(/\\/g, '/');
            
            const resp = await fetch(`${generatedVideo.video.uri}&key=${apiKey}`);
            if (!resp.ok) {
                 console.error(`Failed to download video (Veo 2). Status: ${resp.status} ${resp.statusText}`);
                return;
            }

            const writer = createWriteStream(videoPath);
            await new Promise((resolve, reject) => {
                Readable.fromWeb(resp.body).pipe(writer);
                writer.on('finish', resolve);
                writer.on('error', (err) => { console.error(`Error writing video file ${videoPath}:`, err); reject(err); });
            });
            console.log(`Veo 2 video successfully saved as ${videoPath}`);
            markdown += `\n\n<video controls width="100%"><source src="${relativeVideoPathForMarkdown}" type="video/mp4">Your browser does not support the video tag.</video>\n\n`;
        }));

        if (markdown.length === 0) return { success: false, error: "Veo 2 processing completed, but no videos were successfully saved.", markdown: "<!-- No videos saved -->" };
        return { success: true, markdown: markdown.trim() };

    } catch (error) {
        console.error(`Error in generateAndEmbedVideoVeo2 for prompt "${trimmedPrompt.substring(0, 100)}...":`, error.message);
        return { success: false, error: error.message, markdown: `\n\n<!-- Veo 2 Generation Exception: ${escapeHtml(error.message)} -->\n\n` };
    }
}

async function generateAndEmbedVideoVeo3(videoPromptContent, baseFilename, imageInput = null) {
    const trimmedPrompt = videoPromptContent.trim();
    
    const imageWasUsed = imageInput && imageInput.imageBytes;
    const logStart = imageWasUsed ? `Generating video (with image input)` : `Generating video (text-only)`;
    console.log(`${logStart}: "${trimmedPrompt.substring(0, 150)}..." (using ${VEO_3_MODEL_NAME})`);
    
    try {
        const videoRequest = {
            model: VEO_3_MODEL_NAME,
            prompt: trimmedPrompt,
            config: {
                // 'personGeneration' parameter removed as it's not supported by the Veo 3 preview model
                aspectRatio: "16:9",
            },
        };

        if (imageWasUsed) {
            videoRequest.image = {
                imageBytes: imageInput.imageBytes,
                mimeType: "image/png",
            };
        }

        let operation = await googleGenAIClient.models.generateVideos(videoRequest);

        while (!operation.done) {
            console.log("Waiting for Veo 3 generation to complete...");
            await new Promise((resolve) => setTimeout(resolve, 10000));
            operation = await googleGenAIClient.operations.getVideosOperation({ operation });
        }

        console.log("Veo 3 operation complete. Full response:", JSON.stringify(operation.response, null, 2));
        const generatedVideos = operation.response?.generatedVideos;

        if (!generatedVideos || generatedVideos.length === 0) {
            const refusalReason = operation.response?.promptFeedback?.blockReason || 'No video data or candidates were returned from the API.';
            const errorMsg = `Video generation failed: No videos were generated. Reason: ${refusalReason}`;
            console.error(errorMsg);
            return { success: false, error: errorMsg, markdown: `<!-- ${escapeHtml(errorMsg)} -->` };
        }
        
        let markdown = "";
        await Promise.all(generatedVideos.map(async (generatedVideo, i) => {
            if (!generatedVideo.video?.uri) {
                console.warn(`Skipping Veo 3 video index ${i}: No URI found.`);
                return;
            }
            const videoName = `gemini-video-veo3-${Date.now()}-${baseFilename}-${i}.mp4`;
            const videoPath = path.join(OUTPUT_IMAGES_DIR, videoName);
            const relativeVideoPathForMarkdown = `/${path.basename(OUTPUT_IMAGES_DIR)}/${videoName}`.replace(/\\/g, '/');
            
            const resp = await fetch(`${generatedVideo.video.uri}&key=${apiKey}`);
            if (!resp.ok) {
                 console.error(`Failed to download video (Veo 3). Status: ${resp.status} ${resp.statusText}`);
                return;
            }
            const writer = createWriteStream(videoPath);
            await new Promise((resolve, reject) => {
                Readable.fromWeb(resp.body).pipe(writer);
                writer.on('finish', resolve);
                writer.on('error', (err) => { console.error(`Error writing video file ${videoPath}:`, err); reject(err); });
            });
            console.log(`Veo 3 video successfully saved as ${videoPath}`);
            markdown += `\n\n<video controls width="100%"><source src="${relativeVideoPathForMarkdown}" type="video/mp4">Your browser does not support the video tag.</video>\n\n`;
        }));

        if (markdown.length === 0) return { success: false, error: "Veo 3 processing completed, but no videos were successfully saved.", markdown: "<!-- No videos saved -->" };
        return { success: true, markdown: markdown.trim() };

    } catch (error) {
        console.error(`Error in generateAndEmbedVideoVeo3 for prompt "${trimmedPrompt.substring(0, 100)}...":`, error.message);
        return { success: false, error: error.message, markdown: `\n\n<!-- Veo 3 Generation Exception: ${escapeHtml(error.message)} -->\n\n` };
    }
}

async function generateAndEmbedVideo(videoPromptContent, baseFilename, imageInput = null) {
    if (!googleGenAIClient) {
        console.warn("Skipping video generation: GoogleGenAI client not initialized.");
        return { success: false, error: "Video generation client not initialized.", markdown: "<!-- Video generation skipped: Client not initialized -->", modelUsed: "N/A" };
    }
    if (!videoPromptContent || typeof videoPromptContent !== 'string' || videoPromptContent.trim().length === 0) {
        console.warn("Skipping video generation: Received empty or invalid prompt.");
        return { success: false, error: "No valid prompt provided for video generation.", markdown: "<!-- Video generation skipped: No valid prompt provided -->", modelUsed: "N/A" };
    }

    console.log("Attempting video generation with Veo 3...");
    try {
        const veo3Result = await generateAndEmbedVideoVeo3(videoPromptContent, baseFilename, imageInput);
        if (veo3Result.success) {
            console.log("Veo 3 video generation successful.");
            veo3Result.modelUsed = VEO_3_MODEL_NAME;
            return veo3Result;
        }
        console.warn(`Veo 3 generation failed: ${veo3Result.error}. Falling back to Veo 2.`);
    } catch (error) {
        console.error(`An exception occurred during Veo 3 generation: ${error.message}. Falling back to Veo 2.`);
    }

    console.log("Attempting video generation with Veo 2 as a fallback...");
    const veo2Result = await generateAndEmbedVideoVeo2(videoPromptContent, baseFilename, imageInput);
    veo2Result.modelUsed = VEO_2_MODEL_NAME;
    return veo2Result;
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
        const apiResponse = await googleGenAIClient.models.generateImages({
            model: IMAGE_GEN_MODEL_NAME,
            prompt: trimmedPrompt,
            config: {
                numberOfImages: 1,
            },
        });

        if (!apiResponse || !apiResponse.generatedImages || apiResponse.generatedImages.length === 0) {
            const refusalReason = apiResponse?.promptFeedback?.blockReason || 'No image data or candidates returned.';
            const errorMsg = `Image generation failed: No images generated. Reason: ${refusalReason}`;
            console.error(errorMsg, "API Response:", JSON.stringify(apiResponse, null, 2));
            return { success: false, error: errorMsg, markdown: `<!-- ${escapeHtml(errorMsg)} -->`, refusalReason: refusalReason, detailedErrorInfo: { type: "NoImagesReturned", apiResponse: apiResponse || null } };
        }

        const generatedImage = apiResponse.generatedImages[0];
        let imageDataBuffer;
        let imageExt = '.png';

        if (generatedImage.image?.imageBytes) {
            imageDataBuffer = Buffer.from(generatedImage.image.imageBytes, 'base64');
        } else {
            const errorMsg = "Image generation failed: No imageBytes found in the response.";
            console.error(errorMsg, "Generated Image Object:", generatedImage);
            return { success: false, error: errorMsg, markdown: `<!-- Image Generation Failed: ${escapeHtml(errorMsg)} -->`, refusalReason: errorMsg, detailedErrorInfo: { type: "NoImageBytesInResponse", generatedImage: generatedImage } };
        }
        const imageName = `gemini-img-${Date.now()}-${baseFilename}${imageExt}`;
        const imagePath = path.join(OUTPUT_IMAGES_DIR, imageName);
        const relativeImagePathForMarkdown = `/${path.basename(OUTPUT_IMAGES_DIR)}/${imageName}`.replace(/\\/g, '/');
        await fs.writeFile(imagePath, imageDataBuffer);
        console.log(`Image successfully saved as ${imagePath}`);
        
        // MODIFICATION: Return the imageBytes along with the other data
        return {
            success: true,
            markdown: `\n\n![Generated Image](${relativeImagePathForMarkdown})\n\n`,
            imageBytes: generatedImage.image.imageBytes,
            refusalReason: null,
            detailedErrorInfo: null
        };
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
      let currentAudioStreamLabel = '[0:a]';

      const needsStereo = ['pseudoStereo', 'pingPongEcho'].includes(audioEnhancement.type);
      if (inputChannels === 1 && needsStereo) {
          filterGraph.push(`${currentAudioStreamLabel}asplit[l][r]`);
          filterGraph.push(`[l][r]amerge=inputs=2[stereo_pre_effect]`);
          currentAudioStreamLabel = '[stereo_pre_effect]';
          finalOutputChannels = 2;
      } else if (inputChannels >= 2) {
          finalOutputChannels = 2;
      }

      switch (audioEnhancement.type) {
        case 'pseudoStereo':
            const delayMs = audioEnhancement.delayMs || 25;
            filterGraph.push(`${currentAudioStreamLabel}channelsplit=channel_layout=stereo[L][R]`);
            filterGraph.push(`[R]adelay=${delayMs}|${delayMs}[Rd]`);
            filterGraph.push(`[L][Rd]amerge=inputs=2[aout]`);
            currentAudioStreamLabel = '[aout]';
            logMessage = `FFMPEG: Pseudo-stereo audio encoded to ${outputFilename}`;
            break;
        
        case 'pingPongEcho':
            const pingPongDelay = audioEnhancement.delayMs || 400;
            const pingPongDecay = audioEnhancement.decay || 0.6;
            filterGraph.push(`${currentAudioStreamLabel}asplit=4[orig][delay1_src][delay2_src][delay3_src]`);
            filterGraph.push(`[orig]pan=stereo|c0=c0|c1=0.1*c0[L_direct]`);
            filterGraph.push(`[delay1_src]adelay=${pingPongDelay}[d1]`);
            filterGraph.push(`[d1]volume=${pingPongDecay}[v1]`);
            filterGraph.push(`[v1]pan=stereo|c0=0.1*c0|c1=c0[R_bounce1]`);
            filterGraph.push(`[delay2_src]adelay=${2 * pingPongDelay}[d2]`);
            filterGraph.push(`[d2]volume=${pingPongDecay * pingPongDecay}[v2]`);
            filterGraph.push(`[v2]pan=stereo|c0=c0|c1=0.1*c0[L_bounce2]`);
            filterGraph.push(`[delay3_src]adelay=${3 * pingPongDelay}[d3]`);
            filterGraph.push(`[d3]volume=${pingPongDecay * pingPongDecay * pingPongDecay}[v3]`);
            filterGraph.push(`[v3]pan=stereo|c0=0.1*c0|c1=c0[R_bounce3]`);
            filterGraph.push(`[L_direct][R_bounce1][L_bounce2][R_bounce3]amix=inputs=4[aout]`);
            currentAudioStreamLabel = '[aout]';
            finalOutputChannels = 2;
            logMessage = `FFMPEG: True ping-pong stereo echo applied to ${outputFilename}`;
            break;
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

        await encodePcmToWebmOpus(
            audioPath, pcmAudioBuffer, inputChannelsFromTTS, inputSampleRateFromTTS, inputSampleFormatFromTTS,
            { audioEnhancement: { type: 'pingPongEcho', delayMs: 400, decay: 0.6 }, outputSampleRate: 48000 }
        );

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
        const ext = path.extname(new URL(imageUrl).pathname).toLowerCase();
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

const YOUTUBE_ANALYSIS_PROMPT_UNIFIED = `
Use primarily the **audio** from the provided video to extract special and detailed information from it that would not be provided by normal transcripts.

### Video

If there is video, briefly look at the video track and give a **concise** synopsis of the message, imagery and techniques used in the video.

### Audio

Analyze the provided video's audio track and produce a multi-part analysis.

### Part 1: Comprehensive Transcript
**Your highest priority is to create an accurate and comprehensive transcript of all spoken content.**
- Transcribe all dialogue, speeches, conversations, and song lyrics. Do not summarize or omit content.
- Identify and label different speakers. Use their names if they are known public figures (e.g., "Elon Musk:"), otherwise use generic labels (e.g., "Male Speaker:", "Female Speaker:").
- Present the output as a clean, readable transcript.

### Part 2: Detailed Audio Analysis
After completing the transcript, provide a detailed analysis of the non-speech audio elements.
- **Soundscape:** Describe any natural sounds, ambient noise, or sound effects in detail.
- **Music:** If music is present, describe its genre, instrumentation, composition, and emotional tone in an interesting and historical way.
- **Voice Quality:** Analyze the speakers' vocal characteristics, such as tone, emotion, and accent.

### Part 3: Music Generation Prompt
Based on any music found in the audio, generate a highly detailed, plain text, comma-delimited, single-line text prompt suitable for an AI music generation model (approx. 150 words).
- **Structure:** Start with general terms (era, genre, mood) and become progressively more specific.
- **Content:** Include details on instrumentation, vocals, tempo, dynamics, and overall theme.
- **Constraint:** If a composer or artist is identifiable, mention their name ONLY at the very end of the prompt.
- **Example:** baroque, sacred music, choral, dramatic, powerful, allegro, full orchestra, string section, basso continuo, harpsichord, oboe, trumpets, timpani, large mixed choir (SATB), soprano and alto soloists, intricate polyphony, fugal passages, majestic and solemn tone, powerful dynamic contrasts, intricate counterpoint between voices and instruments, a sense of divine grandeur and authority, reminiscent of the work of George Frideric Handel.
`;


async function performYouTubeAnalysis(audioPart, youtubeUrl, startTime = 'N/A') {
    console.log(`Requesting unified YouTube analysis for ${youtubeUrl}...`);
    try {
        const result = await textModel.generateContent([YOUTUBE_ANALYSIS_PROMPT_UNIFIED, audioPart]);
        const analysisText = result.response.text();
        const markdown = `\n### YouTube Audio Analysis (from ${startTime})\n<pre><code>${escapeHtml(analysisText)}</code></pre>\n`;
        return { success: true, markdown: markdown };
    } catch (error) {
        console.error(`Error during unified YouTube analysis for ${youtubeUrl}:`, error);
        return { success: false, error: error.message };
    }
}


async function analyzeYouTubeAudioLocally(youtubeUrl, startTime = '0', duration = 600) {
    console.log(`Performing local audio analysis for: ${youtubeUrl} (start: ${startTime}s, duration: ${duration}s).`);
    const tempFileName = `temp-audio-${Date.now()}.opus`;
    const tempFilePath = path.join(os.tmpdir(), tempFileName);

    try {
        const ffmpegArgs = `-ss ${startTime} -t ${duration}`;
        
        // Use cookies and a robust format selector to prevent 403 errors.
        const args = [ 
            // '--cookies-from-browser', 'chrome', 
            '-f', 'bestaudio/best', 
            '-x', '--audio-format', 'opus', 
            '--ppa', `ffmpeg:${ffmpegArgs}`, 
            '-o', tempFilePath, 
            youtubeUrl 
        ];

        console.log(`Executing command: yt-dlp ${args.join(' ')}`);
        const { stdout, stderr } = await execFileAsync('yt-dlp', args);
        if (stderr) console.warn('yt-dlp stderr output:\n', stderr);
        console.log('yt-dlp stdout output:\n', stdout);
        console.log(`yt-dlp successfully created temporary file: ${tempFilePath}`);

        const audioFileBuffer = await fs.readFile(tempFilePath);
        const audioPart = { inlineData: { data: audioFileBuffer.toString("base64"), mimeType: "audio/opus" } };
        
        // Use the start time in the analysis title
        return await performYouTubeAnalysis(audioPart, youtubeUrl, `${startTime}s`);

    } catch (error) {
        if (error instanceof GoogleGenerativeAIError) {
             console.error(`An error occurred during Google AI processing for ${youtubeUrl} at ${startTime}s:`, error);
        } else {
             console.error(`An error occurred during local YouTube audio analysis via yt-dlp for ${youtubeUrl} at ${startTime}s:`, error);
        }
        return { success: false, error: error.message };
    } finally {
        try {
            await fs.unlink(tempFilePath);
            console.log(`Successfully deleted temporary file: ${tempFilePath}`);
        } catch (cleanupError) {
            if (cleanupError.code !== 'ENOENT') {
                console.error(`Failed to delete temporary file ${tempFilePath}:`, cleanupError);
            }
        }
    }
}

async function analyzeYouTubeAudio(youtubeUrl) {
    if (useLocalAudioProcessing) {
        console.log("`--local-audio` flag detected. Processing audio in 10-minute chunks.");
        
        const CHUNK_DURATION_SECONDS = 600; // 10 minutes per chunk
        const MAX_CHUNKS = 1; // Process up to 60 minutes of video
        let currentStartTime = parseInt(localAudioStartTime, 10) || 0;
        let combinedMarkdown = "";
        let hasFailures = false;

        for (let i = 0; i < MAX_CHUNKS; i++) {
            console.log(`--- Processing Audio Chunk ${i + 1} of ${MAX_CHUNKS} (starts at ${currentStartTime}s) ---`);
            const result = await analyzeYouTubeAudioLocally(youtubeUrl, currentStartTime, CHUNK_DURATION_SECONDS);

            if (result.success) {
                combinedMarkdown += result.markdown;
            } else {
                hasFailures = true;
                const errorMessage = result.error || 'Unknown error';
                // yt-dlp may fail if the start time is past the end of the video. This is a normal way to end the loop.
                if (errorMessage.includes('Invalid start time') || errorMessage.includes('Conversion failed')) {
                    console.log(`Reached the end of the video at chunk ${i + 1}. Stopping analysis.`);
                    break;
                }
                console.error(`Chunk ${i + 1} failed: ${errorMessage}`);
                combinedMarkdown += `\n### YouTube Audio Analysis (Chunk at ${currentStartTime}s)\n<p><strong>Analysis for this chunk failed.</strong></p>\n<p><em>Error:</em> ${escapeHtml(errorMessage)}</p>\n`;
            }
            
            // Increment start time for the next chunk
            currentStartTime += CHUNK_DURATION_SECONDS;
            
            // Add a small delay between API calls to be safe
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        if (!combinedMarkdown) {
            return { success: false, error: "All audio chunks failed to process." };
        }

        return { success: !hasFailures, markdown: combinedMarkdown };
    }

    console.log(`Analyzing YouTube audio directly from URL: ${youtubeUrl}`);
    try {
        const audioPart = { fileData: { fileUri: youtubeUrl, mimeType: "video/mp4" } };
        return await performYouTubeAnalysis(audioPart, youtubeUrl, 'start');
    } catch (error) {
        console.error(`An error occurred during direct YouTube audio analysis for ${youtubeUrl}:`, error);
        return { success: false, error: error.message };
    }
}

function unescapeHtml(text) {
    if (typeof text !== 'string') return text == null ? '' : String(text);
    return text.replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">").replace(/"/g, "\"").replace(/'/g, "'").replace(/ /g, ' ');
}

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

        let youtubeAnalysisPromise = Promise.resolve(null);
        const sourceUrl = inputData.ogResult.ogUrl;
        // If --local-audio is used, attempt analysis on any URL. Otherwise, only on YouTube URLs.
        if (sourceUrl && (useLocalAudioProcessing || sourceUrl.includes('youtube.com/') || sourceUrl.includes('music.youtube.com/'))) {
            // The cleanYoutubeUrl logic is harmless for non-YouTube URLs and good to keep.
            const cleanUrl = sourceUrl.replace('music.youtube.com', 'youtube.com');
            console.log(`Audio analysis triggered for: ${cleanUrl}`);
            youtubeAnalysisPromise = analyzeYouTubeAudio(cleanUrl);
        }

        const textChunks = [];
        for (let i = 0; i < fullTextContent.length; i += MAX_CHUNK_SIZE_CHARS) textChunks.push(fullTextContent.substring(i, i + MAX_CHUNK_SIZE_CHARS));
        if (textChunks.length === 0 && fullTextContent.length > 0) textChunks.push(fullTextContent);
        if (textChunks.length === 0) { console.warn(`Skipping ${inputFile}: No chunks from content.`); return; }

        const textApiPromises = textChunks.map((chunk) => {
            const userPrompt = selectedPrompt.chat.replace('[[chunk]]', chunk);
            const fullApiPrompt = `${selectedPrompt.system}\n\n${userPrompt}`;
            return textModel.generateContent({ contents: [{ role: "user", parts: [{ text: fullApiPrompt }] }], generationConfig: { maxOutputTokens: 8192 }, tools: [{ googleSearch: {} }] }).catch(err => ({ error: true, message: err.message, feedback: err.promptFeedback }));
        });

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
        let imageInputForVideo = null; // MODIFICATION: Initialize a variable to hold image data for the video step

        if (extractedImagePrompts.length > 0) {
            const promptUsedForImage = extractedImagePrompts[Math.floor(Math.random() * extractedImagePrompts.length)];
            const imgGenRes = await generateAndEmbedImage(promptUsedForImage, baseFilename);
            
            // MODIFICATION: Check for success, log status, and capture the imageBytes
            if (imgGenRes.success && imgGenRes.imageBytes) {
                console.log("✅ Image generation successful. Captured imageBytes for video generation.");
                imageInputForVideo = { imageBytes: imgGenRes.imageBytes };
            } else if (imgGenRes.success) {
                console.warn("⚠️ Image generation succeeded, but imageBytes were not captured. Video will be text-only.");
            }

            if (imgGenRes.success) {
                 figureWithGeneratedImage = `### Generated Image\n${imgGenRes.markdown}\n*Prompt:*\n<pre><code class="language-text">${escapeHtml(promptUsedForImage)}</code></pre>`;
            } else {
                let errorDisplay = `<p><strong>Image Generation Failed.</strong></p><p><em>Error Summary:</em> ${escapeHtml(imgGenRes.error || 'Unknown error')}</p>`;
                if (imgGenRes.refusalReason) { errorDisplay += `\n<p><em>Model's Explanation:</em></p>\n<pre><code class="language-text">${escapeHtml(imgGenRes.refusalReason)}</code></pre>\n`; }
                errorDisplay += `\n<p><em>Attempted prompt:</em></p>\n<pre><code class="language-text">${escapeHtml(promptUsedForImage)}</code></pre>`;
                if (imgGenRes.detailedErrorInfo) { errorDisplay += `\n<details><summary>Click for Detailed Error JSON</summary>\n<pre><code class="language-json">${escapeHtml(JSON.stringify(imgGenRes.detailedErrorInfo, null, 2))}</code></pre>\n</details>\n`; }
                figureWithGeneratedImage = `### Generated Image\n${errorDisplay}`;
            }
        }
        
        let generatedVideoOutput = "<!-- No video prompts found or video generation not attempted -->";
        let videoModelUsed = "N/A";

        if (extractedVideoPrompts.length > 0) {
            const promptUsedForVideo = extractedVideoPrompts[Math.floor(Math.random() * extractedVideoPrompts.length)];
            // MODIFICATION: Pass the captured image data (or null) to the video generation function
            const videoGenRes = await generateAndEmbedVideo(promptUsedForVideo, baseFilename, imageInputForVideo);
            videoModelUsed = videoGenRes.modelUsed || "N/A";

            if (videoGenRes.success) {
                generatedVideoOutput = `### Generated Video\n${videoGenRes.markdown}\n*Prompt:*\n<pre><code class="language-text">${escapeHtml(promptUsedForVideo)}</code></pre>`;
            } else {
                generatedVideoOutput = `### Generated Video\n<p><strong>Video Generation Failed (Both Veo 3 and Veo 2).</strong></p><p><em>Error Summary:</em> ${escapeHtml(videoGenRes.error || 'Unknown error')}</p>\n<p><em>Attempted prompt:</em></p>\n<pre><code class="language-text">${escapeHtml(promptUsedForVideo)}</code></pre>`;
            }
        }

        let youtubeAnalysisOutput = "<!-- Source was not a YouTube video -->";
        if (youtubeAnalysisResult) {
            if (youtubeAnalysisResult.success) { youtubeAnalysisOutput = youtubeAnalysisResult.markdown; }
            else { youtubeAnalysisOutput = `\n### YouTube Audio Analysis\n<p><strong>Audio analysis failed.</strong></p>\n<p><em>Error:</em> ${escapeHtml(youtubeAnalysisResult.error)}</p>\n`; }
        }

        let figureWithGeneratedAudio = "<!-- No suitable text found for TTS -->";
        let textToSynthesize = "";
        let rawTextForTTS = "";

        const allVerseBlocks = [...combinedVerseOutput.matchAll(/<h3 id="v\d+">Verse \d+<\/h3><div>(.*?)<\/div>/gs)];
        let allVerseContent = "";
        if (allVerseBlocks.length > 0) {
            allVerseContent = allVerseBlocks.map(match => match[1]).join(' ');
        }

        if (allVerseContent) {
            const verseOnlyText = allVerseContent.split(/<br\s*\/?>/i)
                .filter(line => !/^\s*rhyme scheme|iambic pentameter|meter:|analysis:|style:/i.test(line.trim()))
                .join(' ');
            rawTextForTTS = cleanTextForTTS(verseOnlyText);
            console.log("TTS: Extracted all verse content for audio.");
        } else {
            let fallbackCandidateText = extractedImagePrompts[0] || firstVerseContentForTTS.text;
            if (fallbackCandidateText) {
                const filteredFallbackText = fallbackCandidateText.split('\n')
                    .filter(line => !/^\s*rhyme scheme|iambic pentameter|meter:|analysis:|style:|prompt:/i.test(line.trim()))
                    .join(' ');
                rawTextForTTS = cleanTextForTTS(filteredFallbackText);
                console.log("TTS: Using fallback (image prompt or first verse) for audio.");
            }
        }

        if (rawTextForTTS) {
            const TARGET_TTS_LENGTH = 700;
            const MIN_TTS_LENGTH = 50;

            let candidateForTTS = rawTextForTTS;

            if (candidateForTTS.length > TARGET_TTS_LENGTH) {
                // Take a slice from the middle
                const midPoint = Math.floor(candidateForTTS.length / 2);
                const startIndex = Math.max(0, midPoint - Math.floor(TARGET_TTS_LENGTH / 2));
                const roughSlice = candidateForTTS.substring(startIndex, startIndex + TARGET_TTS_LENGTH);
                // Try to start at a word boundary
                const firstSpace = roughSlice.indexOf(' ');
                if(firstSpace > -1 && firstSpace < (roughSlice.length / 2)) {
                     candidateForTTS = roughSlice.substring(firstSpace + 1);
                } else {
                     candidateForTTS = roughSlice;
                }
                console.log(`TTS: Sliced text from the middle to ~${TARGET_TTS_LENGTH} chars.`);
            }
            
            if (candidateForTTS.length > MAX_TTS_CHARS) {
                candidateForTTS = candidateForTTS.substring(0, MAX_TTS_CHARS);
            }
            
            textToSynthesize = candidateForTTS;

            if (textToSynthesize.length < MIN_TTS_LENGTH) {
                console.warn(`[TTS WARNING] Final text for TTS is too short (length: ${textToSynthesize.length}). Skipping audio generation.`);
                figureWithGeneratedAudio = `<p><strong>Audio generation skipped.</strong> Selected text was too short after processing.</p>\n` +
                                           `*Attempted text for audio:*\n<pre><code class="language-text">${escapeHtml(rawTextForTTS)}</code></pre>`;
                textToSynthesize = "";
            }
        }
        
        if (textToSynthesize) {
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
${generatedVideoOutput}
<hr>
${youtubeAnalysisOutput}
<hr>
### Generated Audio
*TTS Voice: ${escapeHtml(selectedTtsVoice)}*
${figureWithGeneratedAudio}<hr>
### Generation Details
<details><summary>Models & Prompt</summary>
<p><strong>Text:</strong> ${TEXT_MODEL_NAME} (temp: 1)<br><strong>Vision:</strong> ${VISION_MODEL_NAME}<br><strong>Image Gen:</strong> ${IMAGE_GEN_MODEL_NAME}<br><strong>TTS:</strong> ${TTS_MODEL_DISPLAY_NAME}<br><strong>Video:</strong> ${videoModelUsed}</p>
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
    console.log("Starting Gemini script with TTS, Image Gen, and Video Gen...");

    const localAudioIndex = process.argv.indexOf('--local-audio');
    if (localAudioIndex > -1) {
        useLocalAudioProcessing = true;
        if (process.argv.length > localAudioIndex + 1 && !process.argv[localAudioIndex + 1].startsWith('--')) {
            localAudioStartTime = process.argv[localAudioIndex + 1];
        }
        console.log(`>> Local YouTube audio processing is ENABLED. Starting at: ${localAudioStartTime}.`);
    } else {
        console.log(">> Local YouTube audio processing is DISABLED. Use '--local-audio [time]' to enable.");
    }

    try {
        if (apiKey) {
            googleGenAIClient = new GoogleGenAI({ apiKey: apiKey });
            console.log("GoogleGenAI Client (for TTS, Image & Video Gen) initialized using @google/genai.");
        } else {
            console.error("GoogleGenAI Client NOT initialized: API_KEY missing. TTS, Image & Video Gen will fail.");
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
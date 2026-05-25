import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import util from 'util';

const execFileAsync = util.promisify(execFile);

const COMFY_URL = "http://127.0.0.1:8188";
const OUTPUT_DIR = "./images";
const COMFY_INPUT_DIR = "/home/owen/comfy/ComfyUI/input"; // <-- ADD THIS LINE

// Map to your VoxCPM2 API JSON export
const NODE_LOAD_AUDIO = "3"; 
const NODE_VOX_CLONE = "26";
const NODE_SAVE_AUDIO = "4"; 

// 1. Build Payload for a SINGLE stanza
function buildPayload(text, voiceAudio, index, timeStamp, styleDescription) {
    return {
        "client_id": "voxcpm2_chunked",
        "prompt": {
            [NODE_LOAD_AUDIO]: {
                "class_type": "LoadAudio",
                "inputs": { "audio": voiceAudio }
            },
            [NODE_VOX_CLONE]: {
                "class_type": "VoxCPM2_Clone",
                "inputs": {
                    "model_name": "VoxCPM2",
                    "lora_name": "None",
                    "voice_description": styleDescription, // e.g., "fast, low pitch, resonant" or "Song, Pop"
                    "text": text,
                    "prompt_text": "", 
                    "cfg_value": 2.0,
                    "inference_timesteps": 15, // Bumped to 15 for slightly better quality (as per the video)
                    "max_tokens": 1024,
                    "normalize_text": false,
                    "enable_denoiser": true,
                    "seed": Math.floor(Math.random() * 1000000000), // Force a random seed for natural variance
                    "force_offload": false,
                    "dtype": "auto",
                    "device": "cuda",
                    "enable_asr": false,
                    "retry_max_attempts": 3,
                    "retry_threshold": 6,
                    "torch_compile": false,
                    "reference_audio": [NODE_LOAD_AUDIO, 0]
                }
            },
            // Converted from PreviewAudio to SaveAudio for headless execution
            [NODE_SAVE_AUDIO]: {
                "class_type": "SaveAudio",
                "inputs": {
                    "filename_prefix": `VoxCPM2_Stanza_${index}_${timeStamp}`,
                    "audio": [NODE_VOX_CLONE, 0]
                }
            }
        }
    };
}

// Dynamically downsample reference audio to 24kHz to strip harsh high-frequency transients
async function preprocessVoice(inputFile, prefix) {
    const parsedPath = path.parse(inputFile);
    const tempFilename = `${prefix}_24k_${parsedPath.base}`;
    
    // Build the absolute paths so FFmpeg knows exactly where to look and save
    const inputFullPath = path.join(COMFY_INPUT_DIR, inputFile);
    const outputFullPath = path.join(COMFY_INPUT_DIR, tempFilename);

    // Verify the input file actually exists before telling FFmpeg to process it
    if (!fs.existsSync(inputFullPath)) {
        throw new Error(`Reference audio not found: ${inputFullPath}`);
    }

    await execFileAsync('ffmpeg', [
        '-y',
        '-i', inputFullPath,
        '-ar', '24000', // Downsample to 24kHz to organically roll off the high end
        outputFullPath
    ]);
    
    // Return JUST the filename (not the full path) because ComfyUI's LoadAudio node 
    // expects filenames relative to its input directory!
    return tempFilename; 
}

// 2. Generate and download a single stanza
async function generateStanza(text, voiceAudio, index, timeStamp, styleDescription) {
    const payload = buildPayload(text, voiceAudio, index, timeStamp, styleDescription);
    
    const res = await fetch(`${COMFY_URL}/prompt`, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify(payload) 
    });
    
    if (!res.ok) throw new Error(`ComfyUI Error: ${await res.text()}`);
    const responseData = await res.json();
    const promptId = responseData.prompt_id;
    
    let success = false;
    const startTime = Date.now();
    let savedPath = "";

    // Allow generous time for 2B model inference
    while (Date.now() - startTime < 300000) { 
        await new Promise(r => setTimeout(r, 2000)); 
        const historyRes = await fetch(`${COMFY_URL}/history/${promptId}`);
        const history = await historyRes.json();
        
        if (history[promptId]?.outputs?.[NODE_SAVE_AUDIO]?.audio?.length > 0) {
            const file = history[promptId].outputs[NODE_SAVE_AUDIO].audio[0];
            const dlRes = await fetch(`${COMFY_URL}/view?filename=${file.filename}&subfolder=${file.subfolder}&type=${file.type}`);
            
            if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
            
            savedPath = path.join(OUTPUT_DIR, file.filename);
            const buffer = await dlRes.arrayBuffer();
            fs.writeFileSync(savedPath, Buffer.from(buffer));
            
            success = true;
            break;
        }
        if (history[promptId]?.status?.status_str === 'error') throw new Error("ComfyUI Node Error");
    }
    
    if (!success) throw new Error(`Timeout generating stanza ${index + 1}`);
    return savedPath;
}

// 3. Main Orchestrator
async function main() {
    try {
        console.log("--- Starting VoxCPM2 Chunked & Panned TTS ---");
        
        const args = process.argv.slice(2);
        
        const stateFileIndex = args.findIndex(a => a === '--state-file');
        const stateFilePath = stateFileIndex !== -1 ? args[stateFileIndex + 1] : 'tts_state.json';

        const promptFileIndex = args.findIndex(a => a === '--prompt-file');
        const promptFilePath = promptFileIndex !== -1 ? args[promptFileIndex + 1] : 'poem.txt';

        const refAudio1Index = args.findIndex(a => a === '--ref-audio1');
        const audioVoice1 = refAudio1Index !== -1 ? args[refAudio1Index + 1] : 'galaxy.wav';

        const refAudio2Index = args.findIndex(a => a === '--ref-audio2');
        const audioVoice2 = refAudio2Index !== -1 ? args[refAudio2Index + 1] : 'progress.wav';

        // NEW: Optional Style Tags
        const styleIndex = args.findIndex(a => a === '--style');
        const styleDescription = styleIndex !== -1 ? args[styleIndex + 1] : '';

        if (!fs.existsSync(promptFilePath)) throw new Error(`${promptFilePath} not found`);
        
        let poemText = fs.readFileSync(promptFilePath, 'utf8');
        
        // Split by double-newlines to isolate stanzas
        const stanzas = poemText.split(/\n\s*\n/).map(s => s.trim()).filter(s => s.length > 0);
        if (stanzas.length === 0) throw new Error("Poem file is empty.");

        console.log(`🎛️ Pre-processing reference audio to 24kHz to remove transients...`);
        const cleanVoice1 = await preprocessVoice(audioVoice1, 'v1');
        const cleanVoice2 = await preprocessVoice(audioVoice2, 'v2');

        console.log(`📜 Found ${stanzas.length} stanzas. Generating VoxCPM2 voices...`);
        if (styleDescription) console.log(`🎭 Applied Style/Mood: "${styleDescription}"`);

        const timeStamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
        const generatedFiles = [];

// Generate the stanzas sequentially
        for (let i = 0; i < stanzas.length; i++) {
            // Use the pre-processed 24kHz files
            const currentVoice = (i % 2 === 0) ? cleanVoice1 : cleanVoice2; 
            
            process.stdout.write(`   🗣️  Generating Stanza ${i + 1} (${currentVoice})... `);
            const flatStanza = stanzas[i].replace(/\n/g, ' '); 
            
            const filePath = await generateStanza(flatStanza, currentVoice, i, timeStamp, styleDescription);
            generatedFiles.push(filePath);
            console.log(`Done.`);
        }

        console.log(`\n🎵 Panning and Stitching ${generatedFiles.length} stanzas into stereo...`);
        
        const finalFilename = `VoxCPM2_Alternating_${timeStamp}.flac`;
        const finalFilePath = path.join(OUTPUT_DIR, finalFilename);

        let ffmpegArgs = ['-y'];
        generatedFiles.forEach(f => ffmpegArgs.push('-i', f));

        // Add 1.5 seconds of generated stereo silence to protect the tail
// Update 24000 to 48000
        ffmpegArgs.push('-f', 'lavfi', '-t', '1.5', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');

        let filterGraph = '';
        let concatLabels = '';

        // Spatial panning filter (80/20 Left/Right Alternation)
        for (let i = 0; i < generatedFiles.length; i++) {
            const isVoice1 = (i % 2 === 0);
            const panL = isVoice1 ? '0.8' : '0.2';
            const panR = isVoice1 ? '0.2' : '0.8';

            filterGraph += `[${i}:a]pan=stereo|c0=${panL}*c0|c1=${panR}*c0[a${i}];`;
            concatLabels += `[a${i}]`;
        }

        const silenceIdx = generatedFiles.length;
        concatLabels += `[${silenceIdx}:a]`;
        filterGraph += `${concatLabels}concat=n=${generatedFiles.length + 1}:v=0:a=1[final_out]`;

        await execFileAsync('ffmpeg', [
            ...ffmpegArgs,
            '-filter_complex', filterGraph,
            '-map', '[final_out]',
            '-c:a', 'flac',
            finalFilePath
        ]);

// Clean up the temporary individual line files
        for (const f of generatedFiles) {
            fs.unlinkSync(f);
        }

        // Clean up the 24kHz reference clones using their absolute paths!
        fs.unlinkSync(path.join(COMFY_INPUT_DIR, cleanVoice1));
        fs.unlinkSync(path.join(COMFY_INPUT_DIR, cleanVoice2));

        // Hand the final stitched file back to the main thread
        const outputInfo = { savedFilePath: finalFilePath, filename: finalFilename };
        fs.writeFileSync(stateFilePath, JSON.stringify(outputInfo, null, 2));
        
        console.log(`✅ Success! Final VoxCPM2 alternating track saved to ${stateFilePath}`);

    } catch (e) {
        console.error(`\n❌ Run Failed: ${e.message}`);
        process.exit(1);
    }
}

main();
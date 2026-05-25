import fs from 'fs';
import path from 'path';

const COMFY_URL = "http://127.0.0.1:8188";
const OUTPUT_DIR = "./images";

// Update these Node IDs to match your "Save (API Format)" JSON!
const NODE_LOAD_AUDIO = "13"; 
const NODE_WHISPER = "14";
const NODE_OMNIVOICE = "28";
const NODE_SAVE_AUDIO = "31"; // Make sure you used a SaveAudio node!

function buildPayload(poemText, referenceAudioFilename) {
    const timeStamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14); 

    // This structure explicitly maps every required ComfyUI parameter
    return {
        "client_id": "omnivoice_prod",
        "prompt": {
            [NODE_LOAD_AUDIO]: {
                "class_type": "LoadAudio",
                "inputs": {
                    "audio": referenceAudioFilename // e.g., "galaxy.wav"
                }
            },
            [NODE_WHISPER]: {
                "class_type": "OmniVoiceWhisperLoader",
                "inputs": {
                    // Note: Ensure this matches the exact folder name you used for Whisper
                    "model": "whisper-large-v3-turbo (auto-download)", 
                    "device": "auto",
                    "dtype": "fp16"
                }
            },
            [NODE_OMNIVOICE]: {
                "class_type": "OmniVoiceVoiceCloneTTS",
                "inputs": {
                    "model": "OmniVoice-bf16",
                    "text": poemText,
                    "ref_text": "", // Leave blank to let Whisper auto-transcribe
                    "steps": 32,
                    "guidance_scale": 2,
                    "t_shift": 0.1,
                    "speed": 1.0,
                    "duration": 0,
                    "device": "auto",
                    "dtype": "auto",
                    "attention": "auto",
                    "seed": Math.floor(Math.random() * 1000000000), // Randomize for variance
                    "position_temperature": 5,
                    "class_temperature": 0,
                    "layer_penalty_factor": 5,
                    "denoise": true,
                    "preprocess_prompt": true,
                    "postprocess_output": true,
                    "keep_model_loaded": false,
                    "instruct": "",
                    // Links to the other nodes
                    "ref_audio": [NODE_LOAD_AUDIO, 0],
                    "whisper_model": [NODE_WHISPER, 0]
                }
            },
            [NODE_SAVE_AUDIO]: {
                "class_type": "SaveAudio",
                "inputs": {
                    "filename_prefix": `Omni_Gen_${timeStamp}`,
                    "audio": [NODE_OMNIVOICE, 0]
                }
            }
        }
    };
}

async function main() {
    try {
        console.log("--- Starting OmniVoice TTS Clone ---");
        
        const args = process.argv.slice(2);
        
        const stateFileIndex = args.findIndex(a => a === '--state-file');
        const stateFilePath = stateFileIndex !== -1 ? args[stateFileIndex + 1] : 'tts_state.json';

        const promptFileIndex = args.findIndex(a => a === '--prompt-file');
        const promptFilePath = promptFileIndex !== -1 ? args[promptFileIndex + 1] : 'poem.txt';

        const refAudioIndex = args.findIndex(a => a === '--ref-audio');
        // Default to a known anchor file in ComfyUI/input/
        const referenceAudioFilename = refAudioIndex !== -1 ? args[refAudioIndex + 1] : 'default_anchor.wav';

        if (!fs.existsSync(promptFilePath)) throw new Error(`${promptFilePath} not found`);
        
        const poemText = fs.readFileSync(promptFilePath, 'utf8');
        const payload = buildPayload(poemText, referenceAudioFilename);
        
        const res = await fetch(`${COMFY_URL}/prompt`, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify(payload) 
        });
        
        if (!res.ok) throw new Error(`ComfyUI Error: ${await res.text()}`);
        
        const responseData = await res.json();
        const promptId = responseData.prompt_id;
        console.log(`Job Queued: ${promptId}`);

        let outputInfo = {};
        const startTime = Date.now();
        let success = false;

        // OmniVoice takes longer than Kokoro. Give it a generous timeout (e.g., 5 mins).
        while (Date.now() - startTime < 300000) {
            await new Promise(r => setTimeout(r, 2000)); 
            const historyRes = await fetch(`${COMFY_URL}/history/${promptId}`);
            const history = await historyRes.json();
            
            // Check the SaveAudio node
            if (history[promptId]?.outputs?.[NODE_SAVE_AUDIO]?.audio?.length > 0) {
                const file = history[promptId].outputs[NODE_SAVE_AUDIO].audio[0];
                const dlRes = await fetch(`${COMFY_URL}/view?filename=${file.filename}&subfolder=${file.subfolder}&type=${file.type}`);
                
                if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
                
                const savePath = path.join(OUTPUT_DIR, file.filename);
                const buffer = await dlRes.arrayBuffer();
                fs.writeFileSync(savePath, Buffer.from(buffer));
                
                outputInfo = { savedFilePath: savePath, filename: file.filename };
                success = true;
                break;
            }
            
            if (history[promptId]?.status?.status_str === 'error') {
                throw new Error("ComfyUI Node Error - Check ComfyUI Terminal!");
            }
        }

        if (!success) throw new Error("Timeout generating audio");

        fs.writeFileSync(stateFilePath, JSON.stringify(outputInfo, null, 2));
        console.log(`✅ Success. Saved to ${stateFilePath}`);

    } catch (e) {
        console.error(`❌ Run Failed: ${e.message}`);
        process.exit(1);
    }
}

main();
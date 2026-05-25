import fs from 'fs';
import path from 'path';

const COMFY_URL = "http://127.0.0.1:8188";
const OUTPUT_DIR = "./images";

// Map these to your specific ComfyUI API export!
const NODE_LOAD_SPK_1 = "17"; // LoadAudio for your voice
const NODE_LOAD_SPK_2 = "18"; // LoadAudio for F5 voice
const NODE_MULTI_TTS = "12"; 
const NODE_SAVE_AUDIO = "24";

function formatMultiSpeakerPoem(poemText) {
    // Split the poem into stanzas
    const stanzas = poemText.split(/\n\s*\n/).map(s => s.trim()).filter(s => s.length > 0);
    
    let formattedText = "";
    for (let i = 0; i < stanzas.length; i++) {
        const isSpeakerOne = (i % 2 === 0);
        // Replace single newlines within the stanza with spaces so OmniVoice reads it fluidly
        const flatStanza = stanzas[i].replace(/\n/g, ' '); 
        
        if (isSpeakerOne) {
            formattedText += `[Speaker_1]: ${flatStanza}\n\n`;
        } else {
            formattedText += `[Speaker_2]: ${flatStanza}\n\n`;
        }
    }
    return formattedText.trim();
}

function buildPayload(poemText, audioVoice1, audioVoice2) {
    const timeStamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14); 
    const formattedPoem = formatMultiSpeakerPoem(poemText);

    return {
        "client_id": "omnivoice_multi",
        "prompt": {
            [NODE_LOAD_SPK_1]: {
                "class_type": "LoadAudio",
                "inputs": { "audio": audioVoice1 } // e.g., "my_voice.wav"
            },
            [NODE_LOAD_SPK_2]: {
                "class_type": "LoadAudio",
                "inputs": { "audio": audioVoice2 } // e.g., "F5_ref.wav"
            },
            [NODE_MULTI_TTS]: {
                "class_type": "OmniVoiceMultiSpeakerTTS",
                "inputs": {
                    "model": "OmniVoice-bf16",
                    "text": formattedPoem,
                    "steps": 32,
                    "guidance_scale": 2,
                    "t_shift": 0.1,
                    "speed": 1.0,
                    "pause_between_speakers": 0.3,
                    "device": "auto",
                    "dtype": "auto",
                    "attention": "auto",
                    "position_temperature": 5,
                    "class_temperature": 0,
                    "layer_penalty_factor": 5,
                    "denoise": true,
                    "preprocess_prompt": true,
                    "postprocess_output": true,
                    "seed": Math.floor(Math.random() * 1000000000), // Randomize for variance
                    "keep_model_loaded": false,
                    
                    // The True Dynamic Keys from your API export:
                    "num_speakers": "2",
                    "num_speakers.speaker_1_ref_text": "",
                    "num_speakers.speaker_1_instruct": "",
                    "num_speakers.speaker_2_ref_text": "",
                    "num_speakers.speaker_2_instruct": "",
                    "num_speakers.speaker_1_audio": [NODE_LOAD_SPK_1, 0],
                    "num_speakers.speaker_2_audio": [NODE_LOAD_SPK_2, 0]
                }
            },
            [NODE_SAVE_AUDIO]: {
                "class_type": "SaveAudio",
                "inputs": {
                    "filename_prefix": `Omni_Multi_${timeStamp}`,
                    "audio": [NODE_MULTI_TTS, 0]
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

        // Get Speaker 1
        const refAudio1Index = args.findIndex(a => a === '--ref-audio1');
        const audioVoice1 = refAudio1Index !== -1 ? args[refAudio1Index + 1] : 'owen_anchor.wav';

        // Get Speaker 2
        const refAudio2Index = args.findIndex(a => a === '--ref-audio2');
        const audioVoice2 = refAudio2Index !== -1 ? args[refAudio2Index + 1] : 'F5TTS_test_en_1_ref_short.deep.wav';

        if (!fs.existsSync(promptFilePath)) throw new Error(`${promptFilePath} not found`);
        
        const poemText = fs.readFileSync(promptFilePath, 'utf8');
        
        // Pass BOTH voices into the payload builder
        const payload = buildPayload(poemText, audioVoice1, audioVoice2);
        
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
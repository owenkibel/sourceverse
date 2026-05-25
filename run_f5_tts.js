import fs from 'fs';
import path from 'path';

const COMFY_URL = "http://127.0.0.1:8188";
const OUTPUT_DIR = "./images"; 

function buildPayload(poemText, voiceReference) {
    const timeStamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14); 

    return {
        "client_id": "f5_tts_prod",
        "prompt": {
            "1": { 
                "class_type": "F5TTSAudioInputs", 
                "inputs": { 
                    "sample_text": "", 
                    "speech": poemText, 
                    "seed": Math.floor(Math.random() * 1000000000), 
                    "model": "F5v1", 
                    "vocoder": "auto", 
                    "speed": 1.0, 
                    "model_type": "F5TTS_Base", 
                    "sample_audio": ["2", 0] 
                } 
            },
            "2": { 
                "class_type": "LoadAudio", 
                "inputs": { 
                    "audio": voiceReference 
                } 
            },
            "5": { 
                "class_type": "SaveAudio", 
                "inputs": { 
                    "filename_prefix": `Poem_Gen_${timeStamp}`, 
                    "audio": ["1", 0] 
                } 
            }
        }
    };
}

async function main() {
    try {
        console.log("--- Starting F5-TTS Audio Generation ---");
        
        const args = process.argv.slice(2);
        
        const stateFileIndex = args.findIndex(a => a === '--state-file');
        const stateFilePath = stateFileIndex !== -1 ? args[stateFileIndex + 1] : 'tts_state.json';

        // ---> UPDATED: Now defaults to the example test wav
        const voiceIndex = args.findIndex(a => a === '--voice');
        const voiceReference = voiceIndex !== -1 ? args[voiceIndex + 1] : 'F5TTS_test_en_1_ref_short.wav';

        const promptFileIndex = args.findIndex(a => a === '--prompt-file');
        const promptFilePath = promptFileIndex !== -1 ? args[promptFileIndex + 1] : 'poem.txt';

        if (!fs.existsSync(promptFilePath)) {
            throw new Error(`${promptFilePath} not found`);
        }
        
        const poemText = fs.readFileSync(promptFilePath, 'utf8');
        const payload = buildPayload(poemText, voiceReference);
        
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

        // 3-minute timeout for heavy audio generation
        while (Date.now() - startTime < 180000) {
            await new Promise(r => setTimeout(r, 2000)); 
            const historyRes = await fetch(`${COMFY_URL}/history/${promptId}`);
            const history = await historyRes.json();
            
            if (history[promptId]?.outputs?.["5"]?.audio?.length > 0) {
                const file = history[promptId].outputs["5"].audio[0];
                const dlRes = await fetch(`${COMFY_URL}/view?filename=${file.filename}&subfolder=${file.subfolder}&type=${file.type}`);
                
                if (!fs.existsSync(OUTPUT_DIR)) {
                    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
                }
                
                // Save the intermediate FLAC
                const savePath = path.join(OUTPUT_DIR, file.filename);
                const buffer = await dlRes.arrayBuffer();
                fs.writeFileSync(savePath, Buffer.from(buffer));
                
                outputInfo = { savedFilePath: savePath, filename: file.filename };
                success = true;
                break;
            }
            
            if (history[promptId]?.status?.status_str === 'error') {
                throw new Error("ComfyUI Node Error");
            }
        }

        if (!success) throw new Error("Timeout or no output");

        fs.writeFileSync(stateFilePath, JSON.stringify(outputInfo, null, 2));
        console.log(`Success. Saved to ${stateFilePath}`);

    } catch (e) {
        console.error(`Run Failed: ${e.message}`);
        process.exit(1);
    }
}

main();
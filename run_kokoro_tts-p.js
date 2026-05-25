import fs from 'fs';
import path from 'path';

const COMFY_URL = "http://127.0.0.1:8188";
const OUTPUT_DIR = "./images";

function buildPayload(poemText, voiceSelection) {
    const timeStamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14); 

return {
        "client_id": "kokoro_tts_prod",
        "prompt": {
            "1": {
                "class_type": "GeekyKokoroTTS",
                "inputs": {
                    "text": poemText,
                    "voice": voiceSelection, // e.g., '🇺🇸 🚺 Bella 🔥'
                    "speed": 1.0,
                    "use_gpu": true,
                    // ---> TURN ON BLENDING <---
                    "enable_blending": true, 
                    "second_voice": "🇬🇧 🚺 Emma",
                    "blend_ratio": 0.5 // 0.5 is a perfect 50/50 mix
                }
            },
            // ... SaveAudio node ...
            "3": {
                "class_type": "SaveAudio",
                "inputs": {
                    "filename_prefix": `Kokoro_Gen_${timeStamp}`,
                    "audio": ["1", 0]
                }
            }
        }
    };
}

async function main() {
    try {
        console.log("--- Starting Kokoro TTS Audio Generation ---");
        
        const args = process.argv.slice(2);
        
        const stateFileIndex = args.findIndex(a => a === '--state-file');
        const stateFilePath = stateFileIndex !== -1 ? args[stateFileIndex + 1] : 'tts_state.json';

        const promptFileIndex = args.findIndex(a => a === '--prompt-file');
        const promptFilePath = promptFileIndex !== -1 ? args[promptFileIndex + 1] : 'poem.txt';

        // Defaulting to Bella if no specific voice is passed
        const voiceIndex = args.findIndex(a => a === '--voice');
        const voiceSelection = voiceIndex !== -1 ? args[voiceIndex + 1] : '🇺🇸 🚺 Bella 🔥';

        if (!fs.existsSync(promptFilePath)) {
            throw new Error(`${promptFilePath} not found`);
        }
        
        const poemText = fs.readFileSync(promptFilePath, 'utf8');
        const payload = buildPayload(poemText, voiceSelection);
        
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

        // 2-minute timeout (Kokoro is incredibly fast, it shouldn't take anywhere near this long)
        while (Date.now() - startTime < 120000) {
            await new Promise(r => setTimeout(r, 1500)); 
            const historyRes = await fetch(`${COMFY_URL}/history/${promptId}`);
            const history = await historyRes.json();
            
            // Checking Node "3" (SaveAudio)
            if (history[promptId]?.outputs?.["3"]?.audio?.length > 0) {
                const file = history[promptId].outputs["3"].audio[0];
                const dlRes = await fetch(`${COMFY_URL}/view?filename=${file.filename}&subfolder=${file.subfolder}&type=${file.type}`);
                
                if (!fs.existsSync(OUTPUT_DIR)) {
                    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
                }
                
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
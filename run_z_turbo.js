import fs from 'fs';
import path from 'path';

const COMFY_URL = "http://127.0.0.1:8188";
const OUTPUT_DIR = "./images";

function buildPayload(positiveText, seed) {
    // Generate a clean timestamp string (e.g., 20260301_121008)
    const timeStamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14); 

    return {
        "client_id": "z_turbo_prod",
        "prompt": {
            "9": { "class_type": "UnetLoaderGGUF", "inputs": { "unet_name": "z_image_turbo-Q8_0.gguf" } },
            "7": { "class_type": "CLIPLoaderGGUF", "inputs": { "clip_name": "Qwen3-4B-UD-Q8_K_XL.gguf", "type": "lumina2" } },
            "4": { "class_type": "VAELoader", "inputs": { "vae_name": "ae.safetensors" } },
            "11": { "class_type": "ModelSamplingAuraFlow", "inputs": { "model": ["9", 0], "shift": 3 } },
            "8": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["7", 0], "text": positiveText } },
            "3": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["7", 0], "text": "blurry, ugly, bad quality, distortion, watermark" } },
            // "5": { "class_type": "EmptySD3LatentImage", "inputs": { "width": 1024, "height": 1024, "batch_size": 1 } },
            "5": { "class_type": "EmptySD3LatentImage", "inputs": { "width": 480, "height": 832, "batch_size": 1 } },
            "10": { "class_type": "KSampler", "inputs": { 
                "model": ["11", 0], "positive": ["8", 0], "negative": ["3", 0], "latent_image": ["5", 0], 
                "seed": seed, "control_after_generate": "fixed", "steps": 12, "cfg": 1.0, 
                "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0 
            }},
            "6": { "class_type": "VAEDecode", "inputs": { "samples": ["10", 0], "vae": ["4", 0] } },
            // ---> NEW: Inject the timestamp into the filename prefix
            "18": { "class_type": "SaveImage", "inputs": { "images": ["6", 0], "filename_prefix": `Z_Turbo_Gen_${timeStamp}` } }
        }
    };
}

async function main() {
    try {
        console.log("--- Starting Z-Turbo Image Generation ---");
        
        // 1. Parse Arguments
        const args = process.argv.slice(2);

        // Get the state file argument
        const stateFileIndex = args.findIndex(a => a === '--state-file');
        const stateFilePath = stateFileIndex !== -1 ? args[stateFileIndex + 1] : 'output_state.json';

        // Get the prompt file argument
        const promptFileIndex = args.findIndex(a => a === '--prompt-file');
        const promptFilePath = promptFileIndex !== -1 ? args[promptFileIndex + 1] : 'prompt.txt';

        // 2. Read the prompt
        if (!fs.existsSync(promptFilePath)) {
            throw new Error(`${promptFilePath} not found`);
        }
        const promptText = fs.readFileSync(promptFilePath, 'utf8');
        
        const seed = Math.floor(Math.random() * 1000000000);
        const payload = buildPayload(promptText, seed);
        
        // 3. Queue the Prompt
        const res = await fetch(`${COMFY_URL}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!res.ok) throw new Error(`ComfyUI Error: ${await res.text()}`);
        
        const responseData = await res.json();
        const promptId = responseData.prompt_id;
        console.log(`Job Queued: ${promptId}`);

        // 4. Poll for Completion (60s timeout)
        let outputInfo = {};
        const startTime = Date.now();
        let success = false;

        while (Date.now() - startTime < 60000) {
            await new Promise(r => setTimeout(r, 1000));
            const historyRes = await fetch(`${COMFY_URL}/history/${promptId}`);
            const history = await historyRes.json();
            
            // Check for success
            if (history[promptId]?.outputs?.["18"]?.images?.length > 0) {
                const file = history[promptId].outputs["18"].images[0];
                const dlRes = await fetch(`${COMFY_URL}/view?filename=${file.filename}&subfolder=${file.subfolder}&type=${file.type}`);
                
                if (!fs.existsSync(OUTPUT_DIR)) {
                    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
                }
                
                // We keep the exact filename ComfyUI generated so vertical_thread6.js can cleanly delete the original
                const savePath = path.join(OUTPUT_DIR, file.filename);
                const buffer = await dlRes.arrayBuffer();
                fs.writeFileSync(savePath, Buffer.from(buffer));
                
                outputInfo = { savedFilePath: savePath, filename: file.filename };
                success = true;
                break;
            }
            
            // Check for failure
            if (history[promptId]?.status?.status_str === 'error') {
                throw new Error("ComfyUI Node Error");
            }
        }

        if (!success) throw new Error("Timeout or no output");

        // 5. Save State
        fs.writeFileSync(stateFilePath, JSON.stringify(outputInfo, null, 2));
        console.log(`Success. Saved to ${stateFilePath}`);

    } catch (e) {
        console.error(`Run Failed: ${e.message}`);
        process.exit(1);
    }
}

main();
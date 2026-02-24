import fs from 'fs';
import path from 'path';

const COMFY_URL = "http://127.0.0.1:8188";
const OUTPUT_DIR = "./images";

function buildPayload(positiveText, seed) {
    return {
        "client_id": "z_turbo_prod",
        "prompt": {
            "9": { "class_type": "UnetLoaderGGUF", "inputs": { "unet_name": "z_image_turbo-Q8_0.gguf" } },
            "7": { "class_type": "CLIPLoaderGGUF", "inputs": { "clip_name": "Qwen3-4B-UD-Q8_K_XL.gguf", "type": "lumina2" } },
            "4": { "class_type": "VAELoader", "inputs": { "vae_name": "ae.safetensors" } },
            "11": { "class_type": "ModelSamplingAuraFlow", "inputs": { "model": ["9", 0], "shift": 3 } },
            "8": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["7", 0], "text": positiveText } },
            "3": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["7", 0], "text": "blurry, ugly, bad quality, distortion, watermark" } },
            "5": { "class_type": "EmptySD3LatentImage", "inputs": { "width": 1024, "height": 1024, "batch_size": 1 } },
            "10": { "class_type": "KSampler", "inputs": { 
                "model": ["11", 0], "positive": ["8", 0], "negative": ["3", 0], "latent_image": ["5", 0], 
                "seed": seed, "control_after_generate": "fixed", "steps": 12, "cfg": 1.0, 
                "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0 
            }},
            "6": { "class_type": "VAEDecode", "inputs": { "samples": ["10", 0], "vae": ["4", 0] } },
            "18": { "class_type": "SaveImage", "inputs": { "images": ["6", 0], "filename_prefix": "Z_Turbo_Gen" } }
        }
    };
}

async function main() {
    try {
        console.log("--- Starting Z-Turbo Image Generation ---");
        if (!fs.existsSync('prompt.txt')) throw new Error("prompt.txt not found");
        const promptText = fs.readFileSync('prompt.txt', 'utf8').trim();
        const seed = Math.floor(Math.random() * 1000000000);

        const payload = buildPayload(promptText, seed);
        
        // 1. Queue
        const res = await fetch(`${COMFY_URL}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!res.ok) throw new Error(`ComfyUI Error: ${await res.text()}`);
        const promptId = (await res.json()).prompt_id;
        console.log(`Job Queued: ${promptId}`);

        // 2. Poll (60s timeout)
        let outputInfo = {};
        const startTime = Date.now();
        while (Date.now() - startTime < 60000) {
            await new Promise(r => setTimeout(r, 1000));
            const history = await (await fetch(`${COMFY_URL}/history/${promptId}`)).json();
            
            // Check for success
            if (history[promptId]?.outputs?.["18"]?.images?.length > 0) {
                const file = history[promptId].outputs["18"].images[0];
                const dlRes = await fetch(`${COMFY_URL}/view?filename=${file.filename}&subfolder=${file.subfolder}&type=${file.type}`);
                if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
                const safeName = `z_turbo-${Date.now()}-${file.filename}`;
                const savePath = path.join(OUTPUT_DIR, safeName);
                fs.writeFileSync(savePath, Buffer.from(await dlRes.arrayBuffer()));
                outputInfo = { savedFilePath: savePath, filename: safeName };
                break;
            }
            // Check for failure
            if (history[promptId]?.status?.status_str === 'error') throw new Error("ComfyUI Node Error");
        }

        if (!outputInfo.filename) throw new Error("Timeout or no output");

        const stateFilePath = process.argv[process.argv.indexOf('--state-file') + 1] || 'output_state.json';
        fs.writeFileSync(stateFilePath, JSON.stringify(outputInfo, null, 2));
        console.log(`Success. Saved to ${stateFilePath}`);

    } catch (e) {
        console.error("Run Failed:", e.message);
        process.exit(1);
    }
}

main();
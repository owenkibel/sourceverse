import fs from 'fs';
import path from 'path';

const COMFY_URL = "http://127.0.0.1:8188";
const OUTPUT_DIR = "./images";

function buildPayload(promptText, seed) {
    const timeStamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14); 

    return {
        "client_id": "lens_prod",
        "prompt": {
            "35": { 
                "inputs": { "aspect_ratio": "1:1 (Square)", "megapixels": 2 }, 
                "class_type": "ResolutionSelector" 
            },
            "43": { 
                "inputs": { "filename_prefix": `Lens_Image_${timeStamp}`, "images": ["34:5", 0] }, 
                "class_type": "SaveImage" 
            },
            "34:9": { 
                "inputs": { "vae_name": "flux2-vae.safetensors" }, 
                "class_type": "VAELoader" 
            },
            "34:2": { 
                "inputs": { "clip_name": "gpt_oss_20b_nvfp4.safetensors", "type": "lens", "device": "default" }, 
                "class_type": "CLIPLoader" 
            },
            "34:3": { 
                "inputs": { "text": promptText, "clip": ["34:2", 0] }, 
                "class_type": "CLIPTextEncode" 
            },
            "34:7": { 
                "inputs": { "text": "", "clip": ["34:2", 0] }, 
                "class_type": "CLIPTextEncode" 
            },
            "34:8": { 
                "inputs": { "width": ["34:32", 1], "height": ["34:33", 1], "batch_size": 1 }, 
                "class_type": "EmptyLatentImage" 
            },
            "34:16": { 
                "inputs": { "scheduler": "simple", "steps": 4, "denoise": 1, "model": ["34:21", 0] }, 
                "class_type": "BasicScheduler" 
            },
            "34:18": { 
                "inputs": { "sampler_name": "euler" }, 
                "class_type": "KSamplerSelect" 
            },
            "34:23": { 
                "inputs": { "strength": 1, "pre_cfg": false, "model": ["34:21", 0] }, 
                "class_type": "CFGNorm" 
            },
            "34:10": { 
                "inputs": { "unet_name": "lens_turbo_bf16.safetensors", "weight_dtype": "default" }, 
                "class_type": "UNETLoader" 
            },
            "34:14": {
                "inputs": {
                    "add_noise": true,
                    "noise_seed": seed, // <-- DYNAMIC SEED INJECTED HERE
                    "cfg": 1,
                    "model": ["34:23", 0],
                    "positive": ["34:3", 0],
                    "negative": ["34:7", 0],
                    "sampler": ["34:18", 0],
                    "sigmas": ["34:16", 0],
                    "latent_image": ["34:8", 0]
                },
                "class_type": "SamplerCustom"
            },
            "34:5": { 
                "inputs": { "samples": ["34:14", 0], "vae": ["34:9", 0] }, 
                "class_type": "VAEDecode" 
            },
            "34:21": { 
                "inputs": { "max_shift": 1.15, "base_shift": 0.5, "width": ["34:32", 1], "height": ["34:33", 1], "model": ["34:10", 0] }, 
                "class_type": "ModelSamplingFlux" 
            },
            "34:32": { 
                "inputs": { "expression": "a & -8", "values.a": ["34:30", 0] }, 
                "class_type": "ComfyMathExpression" 
            },
            "34:33": { 
                "inputs": { "expression": "a & -8", "values.a": ["34:31", 0] }, 
                "class_type": "ComfyMathExpression" 
            },
            // "34:31": { 
            //     "inputs": { "value": ["35", 1] }, 
            //     "class_type": "PrimitiveInt" 
            // },
            // "34:30": { 
            //     "inputs": { "value": ["35", 0] }, 
            //     "class_type": "PrimitiveInt" 
            // }
            // Look for these two nodes near the bottom of your buildPayload prompt object
"34:30": { 
    "inputs": { "value": 1064 }, // Changed from ["35", 0] to hardcoded 9:16 Width
    "class_type": "PrimitiveInt" 
},
"34:31": { 
    "inputs": { "value": 1888 }, // Changed from ["35", 1] to hardcoded 9:16 Height
    "class_type": "PrimitiveInt" 
}
        }
    };
}

async function main() {
    try {
        console.log("--- Starting Lens-Turbo Image Generation ---");
        
        // 1. Parse Arguments
        const args = process.argv.slice(2);
        const stateFileIndex = args.findIndex(a => a === '--state-file');
        const stateFilePath = stateFileIndex !== -1 ? args[stateFileIndex + 1] : 'output_state.json';

        const promptFileIndex = args.findIndex(a => a === '--prompt-file');
        const promptFilePath = promptFileIndex !== -1 ? args[promptFileIndex + 1] : 'prompt.txt';

        // 2. Read the prompt
        if (!fs.existsSync(promptFilePath)) {
            throw new Error(`${promptFilePath} not found`);
        }
        const promptText = fs.readFileSync(promptFilePath, 'utf8').trim();
        
        const seed = Math.floor(Math.random() * 100000000000000);
        const payload = buildPayload(promptText, seed);
        
        // 3. Queue the Prompt
        const res = await fetch(`${COMFY_URL}/prompt`, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify(payload) 
        });
        if (!res.ok) throw new Error(`ComfyUI Error: ${await res.text()}`);
        
        const responseData = await res.json();
        const promptId = responseData.prompt_id;
        console.log(`Job Queued: ${promptId}`);

        // 4. Poll for Completion (tracking Node 43 instead of 73)
        let outputInfo = {};
        const startTime = Date.now();
        let success = false;

        while (Date.now() - startTime < 120000) {
            await new Promise(r => setTimeout(r, 2000));
            const historyRes = await fetch(`${COMFY_URL}/history/${promptId}`);
            const history = await historyRes.json();
            
            // Check for success via Node 43 (SaveImage)
            if (history[promptId]?.outputs?.["43"]?.images?.length > 0) {
                const file = history[promptId].outputs["43"].images[0];
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
            
            // Check for failure
            if (history[promptId]?.status?.status_str === 'error') {
                throw new Error("ComfyUI Node Error");
            }
            process.stdout.write(".");
        }

        if (!success) throw new Error("\nTimeout or no output");

        // 5. Save State
        fs.writeFileSync(stateFilePath, JSON.stringify(outputInfo, null, 2));
        console.log(`\n✅ Success. Saved to ${stateFilePath}`);

    } catch (e) {
        console.error(`\n❌ Run Failed: ${e.message}`);
        process.exit(1);
    }
}

main();
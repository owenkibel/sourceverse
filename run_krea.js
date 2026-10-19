import fs from 'fs';
import path from 'path';

const COMFY_URL = "http://127.0.0.1:8188";
const OUTPUT_DIR = "./images";

// Default model filenames (override via --unet or --lora CLI flags if needed)
const DEFAULT_UNET = "krea2_turbo_fp8_scaled.safetensors";
const DEFAULT_CLIP = "qwen3vl_4b_fp8_scaled.safetensors";
const DEFAULT_VAE  = "qwen_image_vae.safetensors";

function buildPayload(promptText, seed, options = {}) {
    const timeStamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const unetName = options.unet || DEFAULT_UNET;
    const loraName = options.lora || null;
    const loraStrength = options.loraStrength ?? 0.6;

    // If an optional LoRA is passed, route UNET (10) -> LoraLoaderModelOnly (18) -> KSampler (16)
    const activeModelNode = loraName ? ["18", 0] : ["10", 0];

    const promptGraph = {
        "10": {
            "inputs": {
                "unet_name": unetName,
                "weight_dtype": "default"
            },
            "class_type": "UNETLoader"
        },
        "11": {
            "inputs": {
                "clip_name": DEFAULT_CLIP,
                "type": "krea2",
                "device": "default"
            },
            "class_type": "CLIPLoader"
        },
        "12": {
            "inputs": {
                "vae_name": DEFAULT_VAE
            },
            "class_type": "VAELoader"
        },
        "13": {
            "inputs": {
                "text": promptText,
                "clip": ["11", 0]
            },
            "class_type": "CLIPTextEncode"
        },
        "14": {
            "inputs": {
                "text": "",
                "clip": ["11", 0]
            },
            "class_type": "CLIPTextEncode"
        },
        "15": {
            "inputs": {
                "width": 1056,  // 9:16 portrait snapped to 16px stride for qwen_image_vae
                "height": 1888,
                "batch_size": 1
            },
            "class_type": "EmptyLatentImage"
        },
        "16": {
            "inputs": {
                "seed": seed,
                "steps": 8,
                "cfg": 1.0,
                "sampler_name": "euler",
                "scheduler": "simple",
                "denoise": 1.0,
                "model": activeModelNode,
                "positive": ["13", 0],
                "negative": ["14", 0],
                "latent_image": ["15", 0]
            },
            "class_type": "KSampler"
        },
        "17": {
            "inputs": {
                "samples": ["16", 0],
                "vae": ["12", 0]
            },
            "class_type": "VAEDecode"
        },
        "43": {
            "inputs": {
                "filename_prefix": `Krea2_Image_${timeStamp}`,
                "images": ["17", 0]
            },
            "class_type": "SaveImage"
        }
    };

    if (loraName) {
        promptGraph["18"] = {
            "inputs": {
                "lora_name": loraName,
                "strength_model": loraStrength,
                "model": ["10", 0]
            },
            "class_type": "LoraLoaderModelOnly"
        };
    }

    return {
        "client_id": "krea2_prod",
        "prompt": promptGraph
    };
}

async function main() {
    try {
        console.log("--- Starting Krea-2 Turbo Image Generation ---");

        // 1. Parse Arguments
        const args = process.argv.slice(2);
        const getArg = (flag, fallback) => {
            const idx = args.findIndex(a => a === flag);
            return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
        };

        const stateFilePath  = getArg('--state-file', 'output_state.json');
        const promptFilePath = getArg('--prompt-file', 'prompt.txt');
        const unetOverride   = getArg('--unet', DEFAULT_UNET);
        const loraOverride   = getArg('--lora', null);
        const loraStrength   = parseFloat(getArg('--lora-strength', '0.6'));

        // 2. Read the prompt
        if (!fs.existsSync(promptFilePath)) {
            throw new Error(`${promptFilePath} not found`);
        }
        const promptText = fs.readFileSync(promptFilePath, 'utf8').trim();

        const seed = Math.floor(Math.random() * 100000000000000);
        const payload = buildPayload(promptText, seed, {
            unet: unetOverride,
            lora: loraOverride,
            loraStrength
        });

        // 3. Queue the Prompt
        const res = await fetch(`${COMFY_URL}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error(`ComfyUI Error: ${await res.text()}`);

        const responseData = await res.json();
        const promptId = responseData.prompt_id;
        console.log(`Job Queued: ${promptId} [UNet: ${unetOverride}${loraOverride ? ` | LoRA: ${loraOverride}` : ''}]`);

        // 4. Poll for Completion (tracking Node 43)
        let outputInfo = {};
        const startTime = Date.now();
        let success = false;

        while (Date.now() - startTime < 180000) {
            await new Promise(r => setTimeout(r, 2000));
            const historyRes = await fetch(`${COMFY_URL}/history/${promptId}`);
            const history = await historyRes.json();

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

            if (history[promptId]?.status?.status_str === 'error') {
                const errMsgs = JSON.stringify(history[promptId]?.status?.messages || []);
                throw new Error(`ComfyUI Node Error: ${errMsgs}`);
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
import fs from 'fs';
import path from 'path';

const COMFY_URL = "http://127.0.0.1:8188";
const OUTPUT_DIR = "./images";

function buildPayload(promptText, seed) {
    const timeStamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14); 

    return {
        "client_id": "ernie_prod",
        "prompt": {
            "73": { "inputs": { "filename_prefix": `Ernie_Image_${timeStamp}`, "images": ["88:65", 0] }, "class_type": "SaveImage" },
            // Changed from 1024x1024 to 768x1344 for high-res 9:16
            "88:71": { "inputs": { "width": 768, "height": 1344, "batch_size": 1 }, "class_type": "EmptyFlux2LatentImage" },
            "88:66": { "inputs": { "unet_name": "ernie-image-turbo-fp8.safetensors", "weight_dtype": "default" }, "class_type": "UNETLoader" },
            "88:65": { "inputs": { "samples": ["88:70", 0], "vae": ["88:63", 0] }, "class_type": "VAEDecode" },
            "88:70": {
                "inputs": {
                    "seed": seed, // <-- DYNAMIC SEED INJECTED HERE
                    "steps": 8,
                    "cfg": 1,
                    "sampler_name": "euler",
                    "scheduler": "simple",
                    "denoise": 1,
                    "model": ["88:66", 0],
                    "positive": ["88:67", 0],
                    "negative": ["88:91", 0],
                    "latent_image": ["88:71", 0]
                },
                "class_type": "KSampler"
            },
            "88:67": { "inputs": { "text": ["88:97", 0], "clip": ["88:62", 0] }, "class_type": "CLIPTextEncode" },
            "88:62": { "inputs": { "clip_name": "ministral-3-3b.safetensors", "type": "flux2", "device": "default" }, "class_type": "CLIPLoader" },
            "88:63": { "inputs": { "vae_name": "flux2-vae.safetensors" }, "class_type": "VAELoader" },
            "88:91": { "inputs": { "conditioning": ["88:67", 0] }, "class_type": "ConditioningZeroOut" },
            "88:93": {
                "inputs": {
                    "string": "<s>[SYSTEM_PROMPT]你是一个专业的文生图 Prompt 增强助手。你将收到用户的简短图片描述及目标生成分辨率，请据此扩写为一段内容丰富、细节充分的视觉描述，以帮助文生图模型生成高质量的图片。仅输出增强后的描述，不要包含任何解释或前缀。[/SYSTEM_PROMPT][INST]{\"prompt\": \"{prompt}\", \"width\": {width}, \"height\": {height}}[/INST]",
                    "find": "{prompt}",
                    "replace": ["88:94", 0]
                },
                "class_type": "StringReplace"
            },
            // ---> DYNAMIC TEXT PROMPT INJECTED HERE <---
            "88:94": { "inputs": { "value": promptText }, "class_type": "PrimitiveStringMultiline" },
            "88:95": {
                "inputs": {
                    "prompt": ["88:102", 0], "max_length": 2048, "sampling_mode": "on",
                    "sampling_mode.temperature": 0.6, "sampling_mode.top_k": 64, "sampling_mode.top_p": 0.8,
                    "sampling_mode.min_p": 0.05, "sampling_mode.repetition_penalty": 1.05, "sampling_mode.seed": 0,
                    "sampling_mode.presence_penalty": 0, "thinking": false, "use_default_template": true,
                    "clip": ["88:98", 0]
                },
                "class_type": "TextGenerate"
            },
            // Note: Prompt enhancement is disabled (false) as it was in your JSON template
            "88:96": { "inputs": { "value": true }, "class_type": "PrimitiveBoolean" },
            "88:97": { "inputs": { "switch": ["88:96", 0], "on_false": ["88:94", 0], "on_true": ["88:95", 0] }, "class_type": "ComfySwitchNode" },
            "88:98": { "inputs": { "clip_name": "ernie-image-prompt-enhancer.safetensors", "type": "flux2", "device": "default" }, "class_type": "CLIPLoader" },
            // Let the internal Prompt Enhancer know the target width
            "88:99": { "inputs": { "preview_markdown": "768", "preview_text": "768", "previewMode": null, "source": 768 }, "class_type": "PreviewAny" },
            
            // Let the internal Prompt Enhancer know the target height
            "88:100": { "inputs": { "preview_markdown": "1344", "preview_text": "1344", "previewMode": null, "source": 1344 }, "class_type": "PreviewAny" },
            "88:101": { "inputs": { "string": ["88:93", 0], "find": "{width}", "replace": ["88:99", 0] }, "class_type": "StringReplace" },
            "88:102": { "inputs": { "string": ["88:101", 0], "find": "{height}", "replace": ["88:100", 0] }, "class_type": "StringReplace" },
            "88:103": {
                "inputs": {
                    "preview_markdown": promptText,
                    "preview_text": promptText,
                    "previewMode": null,
                    "source": ["88:97", 0]
                },
                "class_type": "PreviewAny"
            }
        }
    };
}

async function main() {
    try {
        console.log("--- Starting ERNIE-Image Generation ---");
        
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
        const promptText = fs.readFileSync(promptFilePath, 'utf8');
        
        const seed = Math.floor(Math.random() * 1000000000);
        const payload = buildPayload(promptText, seed);
        
        // 3. Queue the Prompt
        const res = await fetch(`${COMFY_URL}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!res.ok) throw new Error(`ComfyUI Error: ${await res.text()}`);
        
        const responseData = await res.json();
        const promptId = responseData.prompt_id;
        console.log(`Job Queued: ${promptId}`);

        // 4. Poll for Completion (allow up to 2 minutes for model load)
        let outputInfo = {};
        const startTime = Date.now();
        let success = false;

        while (Date.now() - startTime < 120000) {
            await new Promise(r => setTimeout(r, 2000));
            const historyRes = await fetch(`${COMFY_URL}/history/${promptId}`);
            const history = await historyRes.json();
            
            // Check for success via Node 73 (SaveImage)
            if (history[promptId]?.outputs?.["73"]?.images?.length > 0) {
                const file = history[promptId].outputs["73"].images[0];
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
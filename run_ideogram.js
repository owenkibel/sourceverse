import fs from 'fs';
import path from 'path';

const COMFY_URL = "http://127.0.0.1:8188";
const OUTPUT_DIR = "./images";

function buildPayload(promptText, seed) {
    const timeStamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14); 

    // Base workflow graph matching your exact c0a2671af7c4 template layout
    const workflow = {
      "37": {
        "inputs": { "aspect_ratio": "9:16 (Portrait Widescreen)", "megapixels": 1, "multiple": 8 },
        "class_type": "ResolutionSelector"
      },
      "158": {
        "inputs": { "filename_prefix": `Ideogram_V4_${timeStamp}`, "images": ["98:13", 0] },
        "class_type": "SaveImage"
      },
      "98:9": { "inputs": { "vae_name": "flux2-vae.safetensors" }, "class_type": "VAELoader" },
      "98:10": { "inputs": { "conditioning": ["98:24", 0] }, "class_type": "ConditioningZeroOut" },
      "98:11": { "inputs": { "width": ["98:31", 1], "height": ["98:32", 1], "batch_size": 1 }, "class_type": "EmptyFlux2LatentImage" },
      "98:12": {
        "inputs": { "noise": ["98:18", 0], "guider": ["98:155", 0], "sampler": ["98:16", 0], "sigmas": ["98:17", 0], "latent_image": ["98:11", 0] },
        "class_type": "SamplerCustomAdvanced"
      },
      "98:13": { "inputs": { "samples": ["98:12", 0], "vae": ["98:9", 0] }, "class_type": "VAEDecode" },
      "98:16": { "inputs": { "sampler_name": "euler" }, "class_type": "KSamplerSelect" },
      "98:17": { "inputs": { "steps": ["98:151", 1], "width": ["98:31", 1], "height": ["98:32", 1], "mu": ["98:144", 0], "std": ["98:146", 0] }, "class_type": "Ideogram4Scheduler" },
      "98:18": { "inputs": { "noise_seed": seed }, "class_type": "RandomNoise" },
      "98:23": { "inputs": { "unet_name": "ideogram4_fp8_scaled.safetensors", "weight_dtype": "default" }, "class_type": "UNETLoader" },
      "98:24": { "inputs": { "text": "", "clip": ["98:14", 0] }, "class_type": "CLIPTextEncode" },
      "98:144": { "inputs": { "value": ["98:145", 0] }, "class_type": "ComfyNumberConvert" },
      "98:145": { "inputs": { "json_string": ["98:148", 0], "key": "mu" }, "class_type": "JsonExtractString" },
      "98:146": { "inputs": { "value": ["98:150", 0] }, "class_type": "ComfyNumberConvert" },
      "98:147": {
        "inputs": {
          "json_string": "{\n  \"Quality\": {\n    \"num_steps\": 48,\n    \"mu\": 0.0,\n    \"std\": 1.5,\n    \"preset_id\": \"V4_QUALITY_48\"\n  },\n  \"Default\": {\n    \"num_steps\": 20,\n    \"mu\": 0.0,\n    \"std\": 1.75,\n    \"preset_id\": \"V4_DEFAULT_20\"\n  },\n  \"Turbo\": {\n    \"num_steps\": 12,\n    \"mu\": 0.5,\n    \"std\": 1.75,\n    \"preset_id\": \"V4_TURBO_12\"\n  }\n}",
          "key": ["98:156", 0]
        },
        "class_type": "JsonExtractString"
      },
      "98:148": { "inputs": { "string": ["98:147", 0], "find": "'", "replace": "\"" }, "class_type": "StringReplace" },
      "98:149": { "inputs": { "json_string": ["98:148", 0], "key": "num_steps" }, "class_type": "JsonExtractString" },
      "98:150": { "inputs": { "json_string": ["98:148", 0], "key": "std" }, "class_type": "JsonExtractString" },
      "98:151": { "inputs": { "value": ["98:149", 0] }, "class_type": "ComfyNumberConvert" },
      "98:154": { "inputs": { "unet_name": "ideogram4_unconditional_fp8_scaled.safetensors", "weight_dtype": "default" }, "class_type": "UNETLoader" },
      "98:155": { "inputs": { "cfg": 7, "model": ["98:157", 0], "positive": ["98:24", 0], "model_negative": ["98:154", 0], "negative": ["98:10", 0] }, "class_type": "DualModelGuider" },
      "98:156": { "inputs": { "choice": "Default", "index": 1, "option1": "Quality", "option2": "Default", "option3": "Turbo", "option4": "" }, "class_type": "CustomCombo" },
      "98:157": { "inputs": { "cfg": 3, "start_percent": 0.7, "end_percent": 1, "model": ["98:23", 0] }, "class_type": "CFGOverride" },
      "98:14": { "inputs": { "clip_name": "qwen3vl_8b_fp8_scaled.safetensors", "type": "ideogram4", "device": "default" }, "class_type": "CLIPLoader" },
      "98:27": { "inputs": { "value": ["37", 0] }, "class_type": "PrimitiveInt" },
      "98:28": { "inputs": { "value": ["37", 1] }, "class_type": "PrimitiveInt" },
      "98:31": { "inputs": { "expression": "max(((a + 15) // 16) * 16, 256)", "values.a": ["98:27", 0] }, "class_type": "ComfyMathExpression" },
      "98:32": { "inputs": { "expression": "max(((a + 15) // 16) * 16, 256)", "values.a": ["98:28", 0] }, "class_type": "ComfyMathExpression" },
      
      // Upstream compiler node trees
      "134:114": { "inputs": { "value": "" }, "class_type": "PrimitiveStringMultiline" }, 
      "134:115": { "inputs": { "value": promptText }, "class_type": "PrimitiveStringMultiline" },
      "134:163": { "inputs": { "string": ["134:114", 0], "find": "{{original_prompt}}", "replace": ["134:115", 0] }, "class_type": "StringReplace" },
      "134:164": { "inputs": { "source": ["134:166", 1] }, "class_type": "PreviewAny" },
      "134:165": { "inputs": { "source": ["134:167", 1] }, "class_type": "PreviewAny" },
      "134:166": { "inputs": { "expression": "max(((a + 15) // 16) * 16, 256)", "values.a": ["37", 0] }, "class_type": "ComfyMathExpression" },
      "134:167": { "inputs": { "expression": "max(((a + 15) // 16) * 16, 256)", "values.a": ["37", 1] }, "class_type": "ComfyMathExpression" },
      "134:169": { "inputs": { "string": ["134:163", 0], "find": "{{width}}", "replace": ["134:164", 0] }, "class_type": "StringReplace" },
      "134:170": { "inputs": { "string": ["134:169", 0], "find": "{{height}}", "replace": ["134:165", 0] }, "class_type": "StringReplace" }
    };

    // ROUTING SWITCH DETECTOR:
    // If the incoming text contains structured JSON formatting markers, bypass the 
    // upstream compiler and pipe it straight into the core text layout execution layer.
    if (promptText.trim().startsWith('{') && promptText.trim().endsWith('}')) {
        console.log("💎 Structured Layout JSON detected. Injecting straight into CLIP Conditioner.");
        workflow["98:24"].inputs.text = promptText.trim();
    } else {
        console.log("📝 Natural Language string detected. Routing through internal Magic Prompt compiler.");
        // Restores the original internal System Instructions block for standard parsing fallback
        workflow["134:114"].inputs.value = "Convert user idea to structured json output."; 
        workflow["98:24"].inputs.text = ["134:170", 0]; // Links the compiler text pipeline to the encoder
    }

    return { "client_id": "ideogram_v4_pipeline", "prompt": workflow };
}

async function main() {
    try {
        console.log("--- Starting Standalone Ideogram 4 Execution Core ---");
        const args = process.argv.slice(2);
        
        const stateFileIndex = args.findIndex(a => a === '--state-file');
        const stateFilePath = stateFileIndex !== -1 ? args[stateFileIndex + 1] : 'ideogram_state.json';

        const promptFileIndex = args.findIndex(a => a === '--prompt-file');
        const promptFilePath = promptFileIndex !== -1 ? args[promptFileIndex + 1] : 'prompt.txt';

        if (!fs.existsSync(promptFilePath)) {
            throw new Error(`Execution error: ${promptFilePath} anchor file missing.`);
        }
        const promptText = fs.readFileSync(promptFilePath, 'utf8').trim();
        const seed = Math.floor(Math.random() * 100000000000000);
        
        const payload = buildPayload(promptText, seed);

        const res = await fetch(`${COMFY_URL}/prompt`, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify(payload) 
        });
        if (!res.ok) throw new Error(`ComfyUI Endpoint Server Error: ${await res.text()}`);
        
        const responseData = await res.json();
        const promptId = responseData.prompt_id;
        console.log(`Job successfully dispatched to queue. Prompt ID: ${promptId}`);

        let outputInfo = {};
        const startTime = Date.now();
        let success = false;

        // Polling loop targeting Node 158 (SaveImage)
        while (Date.now() - startTime < 180000) {
            await new Promise(r => setTimeout(r, 2000));
            const historyRes = await fetch(`${COMFY_URL}/history/${promptId}`);
            const history = await historyRes.json();
            
            if (history[promptId]?.outputs?.["158"]?.images?.length > 0) {
                const file = history[promptId].outputs["158"].images[0];
                const dlRes = await fetch(`${COMFY_URL}/view?filename=${file.filename}&subfolder=${file.subfolder}&type=${file.type}`);
                
                if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
                
                const savePath = path.join(OUTPUT_DIR, file.filename);
                fs.writeFileSync(savePath, Buffer.from(await dlRes.arrayBuffer()));
                
                outputInfo = { savedFilePath: savePath, filename: file.filename, engine: "Ideogram 4" };
                success = true;
                break;
            }
            
            if (history[promptId]?.status?.status_str === 'error') {
                throw new Error("ComfyUI Node execution halted due to inner processing exception.");
            }
            process.stdout.write(".");
        }

        if (!success) throw new Error("\nGeneration execution window timed out.");
        fs.writeFileSync(stateFilePath, JSON.stringify(outputInfo, null, 2));
        console.log(`\n✅ Render task complete. Synchronization verified: ${stateFilePath}`);

    } catch (e) {
        console.error(`\n❌ Execution Terminated: ${e.message}`);
        process.exit(1);
    }
}

main();
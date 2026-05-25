import fs from 'fs';
import path from 'path';

// --- CONFIGURATION ---
const COMFY_URL = "http://127.0.0.1:8188";
const OUTPUT_DIR = "./images"; // Updated to match vertical_thread6's directory
const COMFY_INPUT_DIR = "/home/owen/comfy/ComfyUI/input"; 
const VIDEO_STATE_FILE = path.join(process.cwd(), '.video_state.json');

function buildVideoPayload(isT2V, imageFilename, videoPrompt, seed) {
    const payload = {
        "client_id": "ltx_video_prod",
        "prompt": {
            // "1": { "class_type": "UnetLoaderGGUF", "inputs": { "unet_name": "ltx-2-3-22b-distilled-Q3_K_M.gguf" } },
            // Inside your buildVideoPayload function:
            "1": { "class_type": "UnetLoaderGGUF", "inputs": { "unet_name": "ltx-2.3-22b-distilled-1.1-Q3_K_M.gguf" } },
            "3": { "class_type": "VAELoader", "inputs": { "vae_name": "LTX23_video_vae_bf16.safetensors" } },
            "4": { "class_type": "CLIPTextEncode", "inputs": { "text": videoPrompt, "clip": ["22", 0] } },
            "5": { "class_type": "LTXVConditioning", "inputs": { "frame_rate": 24, "positive": ["4", 0], "negative": ["14", 0] } },
            
            // Fixed 9:16 Vertical Aspect Ratio applied universally
            "6": { "class_type": "EmptyLTXVLatentVideo", "inputs": { "width": 480, "height": 832, "length": 201, "batch_size": 1 } },
            
            "7": { "class_type": "CFGGuider", "inputs": { "cfg": 2.5, "model": ["1", 0], "positive": ["5", 0], "negative": ["5", 1] } },
            "8": { "class_type": "RandomNoise", "inputs": { "noise_seed": seed } },
            "14": { "class_type": "CLIPTextEncode", "inputs": { "text": "blurry, worst quality, deformed, artifacts, low resolution, glitchy", "clip": ["22", 0] } },
            "15": { "class_type": "KSamplerSelect", "inputs": { "sampler_name": "euler" } },
            "22": { "class_type": "LTXAVTextEncoderLoader", "inputs": { "text_encoder": "gemma_3_12B_it_fp4_mixed.safetensors", "ckpt_name": "ltx-2.3_text_projection_bf16.safetensors", "device": "default" } },
            "12": { "class_type": "VAEDecodeTiled", "inputs": { "tile_size": 512, "overlap": 64, "temporal_size": 64, "temporal_overlap": 8, "samples": ["11", 0], "vae": ["3", 0] } },
            "13": { "class_type": "VHS_VideoCombine", "inputs": { "frame_rate": 24, "loop_count": 0, "filename_prefix": "LTX-2.3-Distilled", "format": "video/h264-mp4", "pix_fmt": "yuv420p", "crf": 19, "save_metadata": true, "trim_to_audio": false, "pingpong": false, "save_output": true, "images": ["12", 0] } }
        }
    };

    // DYNAMIC ROUTING
    if (isT2V) {
        // For Text-to-Video: Route directly to the Empty Latent Video (Node 6)
        payload.prompt["10"] = { "class_type": "LTXVScheduler", "inputs": { "steps": 8, "max_shift": 2.05, "base_shift": 0.95, "stretch": true, "terminal": 0.1, "latent": ["6", 0] } };
        payload.prompt["11"] = { "class_type": "SamplerCustomAdvanced", "inputs": { "noise": ["8", 0], "guider": ["7", 0], "sampler": ["15", 0], "sigmas": ["10", 0], "latent_image": ["6", 0] } };
    } else {
        // For Image-to-Video: Load image and route through the ImgToVideoInplace bridging node (Node 23)
        payload.prompt["42"] = { "class_type": "LoadImage", "inputs": { "image": imageFilename } };
        payload.prompt["23"] = { "class_type": "LTXVImgToVideoInplace", "inputs": { "strength": 0.8, "bypass": false, "vae": ["3", 0], "image": ["42", 0], "latent": ["6", 0] } };
        
        payload.prompt["10"] = { "class_type": "LTXVScheduler", "inputs": { "steps": 8, "max_shift": 2.05, "base_shift": 0.95, "stretch": true, "terminal": 0.1, "latent": ["23", 0] } };
        payload.prompt["11"] = { "class_type": "SamplerCustomAdvanced", "inputs": { "noise": ["8", 0], "guider": ["7", 0], "sampler": ["15", 0], "sigmas": ["10", 0], "latent_image": ["23", 0] } };
    }

    return payload;
}



async function main() {
    try {
        const args = process.argv.slice(2);
        
        // 1. Get dynamically passed arguments & flags
// 1. Get dynamically passed arguments & flags
        const isT2V = args.includes('--t2v'); // Detect the mode
        
        // ---> NEW: Capture the state file path! <---
        const stateFileIndex = args.findIndex(a => a === '--state-file');
        const stateFileTarget = stateFileIndex !== -1 ? args[stateFileIndex + 1] : VIDEO_STATE_FILE;
        
        const promptIndex = args.findIndex(a => a === '--prompt');
        const videoPrompt = promptIndex !== -1 ? args[promptIndex + 1] : "Cinematic motion, slow pan.";
        
        const imgIndex = args.findIndex(a => a === '--image');
        const targetFilename = imgIndex !== -1 ? args[imgIndex + 1] : null;

        let payload = {};
        const seed = Math.floor(Math.random() * 1000000000);
        let comfyInputPath = null; // Declare here so cleanup can access it later

       // 2. Branch Logic: T2V vs I2V
        if (isT2V) {
            console.log(`\n🎬 Mode: Text-to-Video (T2V)`);
            console.log(`Starting LTX-2.3 T2V Generation...`);
            
            // Build unified T2V payload (Image parameter is null)
            payload = buildVideoPayload(true, null, videoPrompt, seed);

        } else {
            console.log(`\n🎬 Mode: Image-to-Video (I2V)`);
            if (!targetFilename) throw new Error("No image filename provided for I2V mode!");
            console.log(`Starting LTX-2.3 I2V Generation for anchor: ${targetFilename}`);

            // Locate the generated image and push it to ComfyUI input (I2V ONLY)
            const sourceImagePath = path.join(OUTPUT_DIR, targetFilename);
            comfyInputPath = path.join(COMFY_INPUT_DIR, targetFilename);
            
            if (!fs.existsSync(sourceImagePath)) throw new Error(`Source image not found at ${sourceImagePath}`);
            fs.copyFileSync(sourceImagePath, comfyInputPath);

            // Build unified I2V payload
            payload = buildVideoPayload(false, targetFilename, videoPrompt, seed);
        }

        // 3. Send Payload (Works universally for both modes now)
        const res = await fetch(`${COMFY_URL}/prompt`, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify(payload) 
        });
        
        if (!res.ok) throw new Error(`Server Error: ${await res.text()}`);
        const { prompt_id } = await res.json();
        
        console.log(`Video generation queued. ID: ${prompt_id}`);

        // 4. Poll for completion (Unchanged - Node 13 works for both!)
        let success = false;
        let outputInfo = {};
        for (let i = 0; i < 300; i++) { // Allow up to 10 minutes
            await new Promise(r => setTimeout(r, 2000));
            const histRes = await fetch(`${COMFY_URL}/history/${prompt_id}`);
            const history = await histRes.json();

            if (history[prompt_id]?.outputs?.["13"]?.gifs?.length > 0) {
                const file = history[prompt_id].outputs["13"].gifs[0];
                const dlRes = await fetch(`${COMFY_URL}/view?filename=${file.filename}&subfolder=${file.subfolder}&type=${file.type}`);
                
                if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
                const savePath = path.join(OUTPUT_DIR, file.filename);
                
                const buffer = await dlRes.arrayBuffer();
                fs.writeFileSync(savePath, Buffer.from(buffer));
                console.log(`\nSuccess! Video saved to: ${savePath}`);
                
                outputInfo = { savedFilePath: savePath, filename: file.filename };
                success = true;
                break;
            }
            if (history[prompt_id]?.status?.status_str === 'error') throw new Error("ComfyUI Node Error.");
        }

        if (!success) throw new Error("Video generation timed out.");
        
 // 5. Cleanup (Conditional!)
        if (comfyInputPath && fs.existsSync(comfyInputPath)) {
            fs.unlinkSync(comfyInputPath); // Only remove if we actually copied an image
        }
        
        // ---> NEW: Write to the dynamic state file path the orchestrator expects <---
        fs.writeFileSync(stateFileTarget, JSON.stringify(outputInfo, null, 2));

    } catch (e) {
        console.error(`\nVideo Generation Failed: ${e.message}`);
        process.exit(1);
    }
}

main().catch(e => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
});
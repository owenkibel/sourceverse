import fs from 'fs';
import path from 'path';

// --- CONFIGURATION ---
const COMFY_URL = "http://127.0.0.1:8188";
const OUTPUT_DIR = "./images"; 
const COMFY_INPUT_DIR = "/home/owen/comfy/ComfyUI/input"; 
const VIDEO_STATE_FILE = path.join(process.cwd(), '.video_state.json');

function buildWanPayload(imageFilename, videoPrompt, seed) {
    const timeStamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);

    return {
        "client_id": "wan_video_prod",
        "prompt": {
            // Dropped to 12 steps to improve speed slightly
            "3": { "class_type": "KSampler", "inputs": { "seed": seed, "steps": 12, "cfg": 6, "sampler_name": "euler", "scheduler": "simple", "denoise": 1, "model": ["54", 0], "positive": ["50", 0], "negative": ["50", 1], "latent_image": ["50", 2] } },
            
            "6": { "class_type": "CLIPTextEncode", "inputs": { "text": videoPrompt, "clip": ["58", 0] } },
            "7": { "class_type": "CLIPTextEncode", "inputs": { "text": "blurry, distorted, morphing, low quality, static, JPEG artifacts", "clip": ["58", 0] } }, 
            "8": { "class_type": "VAEDecodeTiled", "inputs": { "tile_size": 256, "overlap": 64, "temporal_size": 16, "temporal_overlap": 4, "samples": ["3", 0], "vae": ["39", 0] } },
            "39": { "class_type": "VAELoader", "inputs": { "vae_name": "Wan2_1_VAE_bf16.safetensors" } },
            "49": { "class_type": "CLIPVisionLoader", "inputs": { "clip_name": "clip_vision_h_fp16.safetensors" } },
            
            // FIX 1: Set explicit 9:16 resolution (480x832). Pointed start_image to the scaler node (43).
            "50": { "class_type": "WanImageToVideo", "inputs": { "width": 480, "height": 832, "length": 81, "batch_size": 1, "positive": ["6", 0], "negative": ["7", 0], "vae": ["39", 0], "clip_vision_output": ["51", 0], "start_image": ["43", 0] } },
            
            // FIX 2: Route the correctly scaled image into the Vision encoder
            "51": { "class_type": "CLIPVisionEncode", "inputs": { "crop": "none", "clip_vision": ["49", 0], "image": ["43", 0] } },
            
            "52": { "class_type": "LoadImage", "inputs": { "image": imageFilename } },
            
            // FIX 3: Hardware Safety Net - Forces the anchor image into the exact 480x832 shape
            "43": { "class_type": "ImageScale", "inputs": { "upscale_method": "bilinear", "width": 480, "height": 832, "crop": "center", "image": ["52", 0] } },
            
            "54": { "class_type": "ModelSamplingSD3", "inputs": { "shift": 8, "model": ["59", 0] } },
            "55": { "class_type": "CreateVideo", "inputs": { "fps": 16, "images": ["8", 0] } },
            "56": { "class_type": "SaveVideo", "inputs": { "filename_prefix": `Wan_FusionX_${timeStamp}`, "format": "mp4", "codec": "h264", "video": ["55", 0] } },
            "58": { "class_type": "CLIPLoaderGGUF", "inputs": { "clip_name": "umt5-xxl-encoder-Q4_K_M.gguf", "type": "wan", "device": "default" } },
            "59": { "class_type": "UnetLoaderGGUF", "inputs": { "unet_name": "Wan2.1_I2V_14B_FusionX-Q4_K_M.gguf" } } 
        }
    };
}

async function main() {
    let comfyInputPath = null;
    try {
        const args = process.argv.slice(2);
        
        const stateFileIndex = args.findIndex(a => a === '--state-file');
        const stateFileTarget = stateFileIndex !== -1 ? args[stateFileIndex + 1] : VIDEO_STATE_FILE;
        
        const promptIndex = args.findIndex(a => a === '--prompt');
        const videoPrompt = promptIndex !== -1 ? args[promptIndex + 1] : "Cinematic motion, slow pan.";
        
        const imgIndex = args.findIndex(a => a === '--image');
        const targetFilename = imgIndex !== -1 ? args[imgIndex + 1] : null;

        if (!targetFilename) throw new Error("No image filename provided! This script requires --image [filename] for Wan I2V.");
        
        console.log(`\n🎬 Mode: Image-to-Video (I2V)`);
        console.log(`Starting Wan-2.1 I2V Generation for anchor: ${targetFilename}`);

        // 1. Locate the anchor and push it to ComfyUI input
        const sourceImagePath = path.join(OUTPUT_DIR, targetFilename);
        comfyInputPath = path.join(COMFY_INPUT_DIR, targetFilename);
        
        if (!fs.existsSync(sourceImagePath)) throw new Error(`Source image not found at ${sourceImagePath}`);
        fs.copyFileSync(sourceImagePath, comfyInputPath);

        // 2. Build and Send Payload
        const seed = Math.floor(Math.random() * 1000000000);
        const payload = buildWanPayload(targetFilename, videoPrompt, seed);
        
        const res = await fetch(`${COMFY_URL}/prompt`, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify(payload) 
        });
        
        if (!res.ok) throw new Error(`Server Error: ${await res.text()}`);
        const { prompt_id } = await res.json();
        
        console.log(`Video generation queued. ID: ${prompt_id}`);

        // 3. Bulletproof Polling Loop
        let success = false;
        let outputInfo = {};
        for (let i = 0; i < 1000; i++) { // Allow up to ~33 minutes
            await new Promise(r => setTimeout(r, 2000));
            const histRes = await fetch(`${COMFY_URL}/history/${prompt_id}`);
            const history = await histRes.json();

            if (history[prompt_id]) {
                if (history[prompt_id].status?.status_str === 'error') {
                    throw new Error("ComfyUI Node Error.");
                }

                const outputNode = history[prompt_id].outputs?.["56"];
                
                // Accounts for ComfyUI putting SaveVideo MP4s inside the 'images' array
                if (outputNode && (outputNode.images?.length > 0 || outputNode.videos?.length > 0 || outputNode.gifs?.length > 0)) {
                    const file = outputNode.images?.[0] || outputNode.videos?.[0] || outputNode.gifs?.[0];
                    const dlRes = await fetch(`${COMFY_URL}/view?filename=${file.filename}&subfolder=${file.subfolder}&type=${file.type}`);
                    
                    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
                    const savePath = path.join(OUTPUT_DIR, file.filename);
                    
                    const buffer = await dlRes.arrayBuffer();
                    fs.writeFileSync(savePath, Buffer.from(buffer));
                    console.log(`\n✅ Success! Video saved to: ${savePath}`);
                    
                    outputInfo = { savedFilePath: savePath, filename: file.filename };
                    success = true;
                    break;
                }
            }
            process.stdout.write(".");
        }

        if (!success) throw new Error("\nVideo generation timed out.");
        
        // 4. Cleanup & Save State
        if (comfyInputPath && fs.existsSync(comfyInputPath)) fs.unlinkSync(comfyInputPath); 
        fs.writeFileSync(stateFileTarget, JSON.stringify(outputInfo, null, 2));

    } catch (e) {
        if (comfyInputPath && fs.existsSync(comfyInputPath)) fs.unlinkSync(comfyInputPath); 
        console.error(`\n❌ Video Generation Failed: ${e.message}`);
        process.exit(1);
    }
}

main().catch(e => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
});
import fs from 'fs';
import path from 'path';

// --- CONFIGURATION ---
const COMFY_URL = "http://127.0.0.1:8188";
const OUTPUT_DIR = "./images"; 
const VIDEO_STATE_FILE = path.join(process.cwd(), '.video_state.json');

function buildFastHunyuanPayload(videoPrompt, seed) {
    const timeStamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);

    return {
        "client_id": "fasthunyuan_t2v",
        "prompt": {
            // 1. The 13B Distilled Model
            "1": { "class_type": "UnetLoaderGGUF", "inputs": { "unet_name": "fast-hunyuan-video-t2v-720p-Q4_K_M.gguf" } },
            "2": { "class_type": "VAELoader", "inputs": { "vae_name": "hunyuan_video_vae_bf16.safetensors" } },
            "3": { "class_type": "DualCLIPLoaderGGUF", "inputs": { "clip_name1": "clip_l.safetensors", "clip_name2": "llava-llama-3-8B-v1_1-Q4_K_M.gguf", "type": "hunyuan_video" } },
            "4": { "class_type": "CLIPTextEncode", "inputs": { "text": videoPrompt, "clip": ["3", 0] } },
            "5": { "class_type": "CLIPTextEncode", "inputs": { "text": "watermark, text, blurry, low quality, artifacts, distortion", "clip": ["3", 0] } },
            
            // Guidance
            "6": { "class_type": "FluxGuidance", "inputs": { "guidance": 7.0, "conditioning": ["4", 0] } },
            
           // Script Speed Mode: 73 frames (~3 seconds) to ensure zero VRAM swap
            "8": { "class_type": "EmptyHunyuanLatentVideo", "inputs": { "width": 480, "height": 832, "length": 73, "batch_size": 1 } },
            // "8": { "class_type": "EmptyHunyuanLatentVideo", "inputs": { "width": 480, "height": 832, "length": 121, "batch_size": 1 } },
            
            // Script Speed Mode: 6 Steps (The FastHunyuan minimum)
            "9": { "class_type": "KSampler", "inputs": { "seed": seed, "steps": 6, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0, "model": ["1", 0], "positive": ["6", 0], "negative": ["5", 0], "latent_image": ["8", 0] } },
            
            // VAE Decode & Save
            "10": { "class_type": "VAEDecodeTiled", "inputs": { "tile_size": 256, "overlap": 64, "temporal_size": 16, "temporal_overlap": 4, "samples": ["9", 0], "vae": ["2", 0] } },
            "12": { "class_type": "CreateVideo", "inputs": { "fps": 24, "images": ["10", 0] } },
            "11": { "class_type": "SaveVideo", "inputs": { "filename_prefix": `FastHunyuan_720p_${timeStamp}`, "format": "mp4", "codec": "h264", "video": ["12", 0] } }
        }
    };
}

async function main() {
    try {
        const args = process.argv.slice(2);
        
        const stateFileIndex = args.findIndex(a => a === '--state-file');
        const stateFileTarget = stateFileIndex !== -1 ? args[stateFileIndex + 1] : VIDEO_STATE_FILE;
        
        const promptIndex = args.findIndex(a => a === '--prompt');
        const videoPrompt = promptIndex !== -1 ? args[promptIndex + 1] : "Cinematic motion, slow pan.";

        console.log(`\n🎬 Mode: Text-to-Video (T2V)`);
        console.log(`Starting FastHunyuan T2V Generation...`);

        // Build and Send Payload (No image processing needed!)
        const seed = Math.floor(Math.random() * 1000000000);
        const payload = buildFastHunyuanPayload(videoPrompt, seed);
        
        const res = await fetch(`${COMFY_URL}/prompt`, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify(payload) 
        });
        
        if (!res.ok) throw new Error(`Server Error: ${await res.text()}`);
        const { prompt_id } = await res.json();
        
        console.log(`Video generation queued. ID: ${prompt_id}`);

        // Bulletproof Polling Loop
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

                // UPDATED: FastHunyuan saves to Node 11, not 56!
                const outputNode = history[prompt_id].outputs?.["11"];
                
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
        
        // Save State
        fs.writeFileSync(stateFileTarget, JSON.stringify(outputInfo, null, 2));

    } catch (e) {
        console.error(`\n❌ Video Generation Failed: ${e.message}`);
        process.exit(1);
    }
}

main().catch(e => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
});
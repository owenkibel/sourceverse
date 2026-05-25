const fs = require('fs/promises');
const path = require('path');

// --- CONFIGURATION ---
const COMFY_URL = "http://127.0.0.1:8188";
const COMFY_OUTPUT_DIR = '/home/owen/comfy/ComfyUI/output';

async function freeComfyVRAM() {
    console.log("🧹 Emptying ComfyUI VRAM cache...");
    try {
        await fetch(`${COMFY_URL}/free`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ unload_models: true, free_memory: true })
        });
        console.log("   ✅ VRAM flushed.");
    } catch (e) {
        console.warn("   ⚠️ Could not reach ComfyUI to clear VRAM.");
    }
}

async function main() {
    try {
        console.log("=== Starting Standalone HeartMuLa 4-bit Test ===");

        // 1. Ensure a completely clean slate
        await freeComfyVRAM();
        await new Promise(r => setTimeout(r, 2000)); 

        // 2. Build the API Payload
        const workflow = {
          "1": {
            "inputs": {
              "lyrics": "[Intro]\nTesting the four-bit safetensors.\nBypassing the bits and bytes bug.",
              "tags": "high fidelity, stereo, clear vocals",
              "model": "HeartMuLa-3B-4bit",
              // ---> THE FIX: Turn off on-the-fly quantization! <---
              // The safetensors are already small enough.
              "quantize": "none", 
              "duration_seconds": 30, 
              "cfg_scale": 2.0,
              "temperature": 1.0,
              "top_k": 50,
              "fade_out": 3.0, 
              "output_format": "wav",
              "filename_prefix": "ForgeAI_test_run"
            },
            "class_type": "ForgeAI_HeartMuLa_Generate"
          }
        };

        // 3. Submit the workflow
        console.log("🚀 Sending payload to ComfyUI...");
        const promptRes = await fetch(`${COMFY_URL}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: workflow })
        });
        
        if (!promptRes.ok) throw new Error(`Server returned ${promptRes.status}: ${await promptRes.text()}`);
        const promptData = await promptRes.json();
        const promptId = promptData.prompt_id;
        
        console.log(`   ⏳ Processing (Prompt ID: ${promptId})...`);

        // 4. Poll History & Scan Directory
        let audioOutput = null;
        let isDone = false;
        
        while (!isDone) {
            await new Promise(r => setTimeout(r, 5000));
            
            const histRes = await fetch(`${COMFY_URL}/history/${promptId}`);
            const histData = await histRes.json();
            
            if (histData[promptId]) {
                isDone = true;
                console.log("   ✅ API reports generation finished. Scanning output folder...");
                
                const files = await fs.readdir(COMFY_OUTPUT_DIR);
                const forgeFiles = files.filter(f => f.startsWith("ForgeAI_test_run") && f.endsWith(".wav"));
                
                if (forgeFiles.length > 0) {
                    let newestFile = forgeFiles[0];
                    let newestTime = (await fs.stat(path.join(COMFY_OUTPUT_DIR, newestFile))).mtimeMs;
                    
                    for (let i = 1; i < forgeFiles.length; i++) {
                        const stats = await fs.stat(path.join(COMFY_OUTPUT_DIR, forgeFiles[i]));
                        if (stats.mtimeMs > newestTime) {
                            newestTime = stats.mtimeMs;
                            newestFile = forgeFiles[i];
                        }
                    }
                    audioOutput = newestFile;
                }
            }
        }

        if (!audioOutput) {
            throw new Error("Generation finished, but no audio file could be found in the output folder.");
        }

        console.log(`\n🎉 Success! Audio saved to: ${path.join(COMFY_OUTPUT_DIR, audioOutput)}`);

    } catch (err) {
        console.error(`\n❌ Test Failed: ${err.message}`);
        process.exit(1);
    }
}

main();
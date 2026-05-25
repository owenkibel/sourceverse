const fs = require('fs/promises');
const path = require('path');

// --- CONFIGURATION ---
const COMFY_OUTPUT_DIR = '/home/owen/comfy/ComfyUI/output';

async function main() {
    // 1. Parse Arguments
    const args = process.argv.slice(2);
    const stateFileIndex = args.findIndex(a => a === '--state-file');
    if (stateFileIndex === -1 || !args[stateFileIndex + 1]) {
        throw new Error("--state-file argument missing");
    }
    const stateFile = args[stateFileIndex + 1];
    
    // 2. Read the prompt data injected by vertical_thread.js
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));

    // 3. Build the ComfyUI API Payload
    const workflow = {
      "1": {
        "inputs": {
          "lyrics": state.lyrics || "[Intro]\nA basic test.",
          "tags": state.tags || "high fidelity, stereo",
          "model": "HeartMuLa-3B-4bit", // <-- Revert to exactly what's in your folder
          "quantize": "4bit",           // <-- Turn the bitsandbytes loader back on
          "duration_seconds": state.duration || 90,
          "cfg_scale": 2.0,
          "temperature": 1.0,
          "top_k": 50,
          "fade_out": 3.0, 
          "output_format": "wav",
          "filename_prefix": "ForgeAI_music"
        },
        "class_type": "ForgeAI_HeartMuLa_Generate"
      }
    };

    // 4. Submit the workflow to the local ComfyUI server
    const promptRes = await fetch('http://127.0.0.1:8188/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: workflow })
    });
    
    const promptData = await promptRes.json();
    const promptId = promptData.prompt_id;
    if (!promptId) throw new Error("Failed to get prompt_id from ComfyUI.");

    console.log(`   ⏳ ComfyUI Processing Audio (Prompt ID: ${promptId})...`);

    // 5. Poll History and Grab the File
    let audioOutput = null;
    let isDone = false;
    
    while (!isDone) {
        await new Promise(r => setTimeout(r, 5000)); // Check every 5 seconds
        
        const histRes = await fetch(`http://127.0.0.1:8188/history/${promptId}`);
        const histData = await histRes.json();
        
        // If the prompt ID appears in history, generation is done!
        if (histData[promptId]) {
            isDone = true;
            const outputs = histData[promptId].outputs;
            
            // Attempt A: Check if the node politely reported the file via the API
            if (outputs && outputs["1"]) {
                const possibleKeys = ["audio", "files", "gifs", "text"];
                for (const key of possibleKeys) {
                    if (outputs["1"][key] && outputs["1"][key].length > 0) {
                        const fileData = outputs["1"][key][0];
                        if (fileData.filename) {
                            audioOutput = fileData.subfolder ? path.join(fileData.subfolder, fileData.filename) : fileData.filename;
                            break;
                        }
                    }
                }
            }
            
            // Attempt B (The Fallback): Manually grab the newest file from the output directory
            if (!audioOutput) {
                console.log("   ⚠️ API didn't report filename. Scanning output directory for newest file...");
                const files = await fs.readdir(COMFY_OUTPUT_DIR);
                const forgeFiles = files.filter(f => f.startsWith("ForgeAI_music") && f.endsWith(".wav"));
                
                if (forgeFiles.length > 0) {
                    // Find the file with the most recent modification time
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
    }

    if (!audioOutput) throw new Error("Generation finished, but no audio file could be found via API or in the output folder.");

    // 6. Save the successful filename back into the state file
    state.success = true;
    state.comfy_output = audioOutput;
    await fs.writeFile(stateFile, JSON.stringify(state));
}

main().catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
});
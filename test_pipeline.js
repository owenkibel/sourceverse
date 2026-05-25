const { execFile } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const util = require('util');
const execFileAsync = util.promisify(execFile);

const IMAGE_PROMPT = "A close-up portrait of a cinematic, glowing neon sign in a dark rainy city.";
const VIDEO_PROMPT = "Rain drops hit the sign, causing it to spark slightly. Slow cinematic camera pan to the right.";

async function freeComfyVRAM() {
    console.log("🧹 Telling ComfyUI to release VRAM...");
    try {
        await fetch('http://127.0.0.1:8188/free', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ unload_models: true, free_memory: true })
        });
        console.log("   ✅ ComfyUI VRAM cleared.");
    } catch (e) {
        console.warn("   ⚠️ Could not reach ComfyUI.");
    }
}

async function runTest() {
    const stateFile = path.join(os.tmpdir(), `img-state-test.json`);
    const promptFile = path.join(os.tmpdir(), `img-prompt-test.txt`);

    try {
        console.log("=== STARTING PIPELINE TEST ===");
        
        // 1. Write the test image prompt
        await fs.writeFile(promptFile, IMAGE_PROMPT, 'utf8');

        // 2. Generate Image
        console.log("\n🎨 1. Generating Image with Z-Turbo...");
        await execFileAsync('bun', ['run_z_turbo.js', '--state-file', stateFile, '--prompt-file', promptFile]);
        console.log("   ✅ Image generated and state saved.");

        // 3. Clear Memory (Crucial for 16GB GPU)
        await freeComfyVRAM();
        await new Promise(r => setTimeout(r, 1000)); // Let the system catch up

        // 4. Read the state file to ensure it's there
        const stateData = JSON.parse(await fs.readFile(stateFile, 'utf8'));
        // Temporarily copy the state to the local directory where run_ltx_video expects it
        await fs.writeFile('.prompt_state.json', JSON.stringify(stateData));

        // 5. Generate Video
        console.log(`\n🎬 2. Generating Video with LTX-2.3...`);
        console.log(`   Prompt: "${VIDEO_PROMPT}"`);
        
        const { stdout: videoOut, stderr: videoErr } = await execFileAsync('bun', [
            'run_ltx_video.js', 
            '--prompt', VIDEO_PROMPT
        ]);
        
        console.log(videoOut);
        if (videoErr) console.warn(videoErr);

        console.log("\n=== PIPELINE TEST COMPLETE ===");

    } catch (e) {
        console.error("Test failed:", e);
    } finally {
        await fs.unlink(stateFile).catch(() => {});
        await fs.unlink(promptFile).catch(() => {});
    }
}

runTest();
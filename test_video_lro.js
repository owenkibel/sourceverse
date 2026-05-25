const fs = require('fs');
const path = require('path');

const API_KEY = process.env.GEMINI_API_KEY1;
const MODEL_NAME = "veo-3.1-fast-generate-preview";

// Ensure the output directory exists
const OUTPUT_DIR = path.join(__dirname, 'media_out');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

async function generateVeoVideo() {
    console.log("Starting Veo LRO (Long Running Operation) Test...\n");

    if (!API_KEY) {
        console.error("❌ Error: GEMINI_API_KEY1 is not set in your environment.");
        return;
    }

    // This is the exact REST endpoint for Veo LROs
    const startUrl = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:predictLongRunning?key=${API_KEY}`;
    
    // Veo uses a slightly different JSON payload schema than standard Gemini
    const payload = {
        "instances": [
            { "prompt": "A static wide shot of a silver rocket on a launch pad at dusk. The camera is locked off and stationary. There is a slight wisp of condensation vapor near the base. Minimal movement, highly realistic lighting." }
        ]
    };

    try {
        // ==========================================
        // STEP 1: DROP OFF THE PROMPT
        // ==========================================
        console.log(`📤 Sending visual prompt to ${MODEL_NAME}...`);
        const startResponse = await fetch(startUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const startData = await startResponse.json();
        
        if (startData.error) {
             console.error("\n❌ API Error on Start:", startData.error.message);
             return;
        }

        const operationName = startData.name;
        console.log(`✅ Request accepted!`);
        console.log(`🎟️  Operation Ticket: ${operationName}`);
        console.log(`⏳ Now polling for completion (this usually takes 1-3 minutes)...\n`);

        // ==========================================
        // STEP 2: POLL UNTIL FINISHED
        // ==========================================
        const pollUrl = `https://generativelanguage.googleapis.com/v1beta/${operationName}?key=${API_KEY}`;
        
        let isDone = false;
        let finalResponseData = null;

        while (!isDone) {
            process.stdout.write("Checking server status... ");
            const pollResponse = await fetch(pollUrl);
            const pollData = await pollResponse.json();

            if (pollData.error) {
                console.error("\n❌ Polling Error:", pollData.error.message);
                return;
            }

            if (pollData.done === true) {
                console.log("DONE! 🎉\n");
                finalResponseData = pollData.response;
                isDone = true;
            } else {
                console.log("Still rendering frames. Waiting 10 seconds...");
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
        }

        // ==========================================
        // STEP 3: EXTRACT URI AND DOWNLOAD MP4
        // ==========================================
        try {
            // Veo returns a secure download link instead of inline base64
            const videoUri = finalResponseData.generateVideoResponse.generatedSamples[0].video.uri;
            console.log(`🔗 Secured Video URI: ${videoUri.substring(0, 60)}...`);
            console.log(`⬇️  Downloading raw MP4 data to disk...`);

            // We must pass the API key as a header to authorize the file download
            const videoResponse = await fetch(videoUri, {
                headers: { 'x-goog-api-key': API_KEY }
            });

            if (!videoResponse.ok) {
                throw new Error(`Download failed: ${videoResponse.statusText}`);
            }

            // Convert the raw data to a buffer and write the file
            const arrayBuffer = await videoResponse.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            
            const outputPath = path.join(OUTPUT_DIR, 'veo_rocket.mp4');
            fs.writeFileSync(outputPath, buffer);
            console.log(`\n🎉 MASSIVE SUCCESS: Video cleanly saved to ${outputPath}`);
            
            // Save the slim JSON for your records
            const slimJsonPath = path.join(OUTPUT_DIR, 'veo_metadata.json');
            fs.writeFileSync(slimJsonPath, JSON.stringify(finalResponseData, null, 2));
            console.log(`💾 Metadata JSON saved to ${slimJsonPath}`);

        } catch (extractError) {
            console.error("\n❌ Error extracting or downloading video:", extractError.message);
            console.log("Raw Response JSON to debug:", JSON.stringify(finalResponseData, null, 2));
        }

    } catch (error) {
        console.error("\n❌ Fatal Network Error:", error.message);
    }
}

generateVeoVideo();
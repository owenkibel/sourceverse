const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');

// Initialize the API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY1);

// Ensure the output directory exists
const OUTPUT_DIR = path.join(__dirname, 'media_out');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

async function testSynthwaveAudio() {
    console.log("Starting Slim Pro Audio Test (Synthwave Edition)...\n");
    
    if (!process.env.GEMINI_API_KEY1) {
        console.error("❌ Error: GEMINI_API_KEY1 is not set in your environment.");
        return;
    }

    try {
        console.log("Sending structured Synthwave prompt to Lyria Pro...");
        const musicModel = genAI.getGenerativeModel({ model: "lyria-3-pro-preview" });
        
        // A moody, atmospheric electronic prompt
        const songPrompt = `
[Genre: Synthwave / Retrowave]
[Tempo: Mid-tempo, driving, atmospheric]

[Intro]
(Pulsing analog bassline, sweeping synthesizer pads)

[Verse 1]
Neon reflecting on wet concrete
Tracing the grid of the empty street
Data is flowing, the signal is pure
Lost in the static, the digital cure

[Chorus]
Ride the wave, the glowing line
Leaving the physical world behind
Pulse in the wire, ghost in the machine
Living forever inside of the screen

[Outro]
(Heavy gated snare fades into distant analog echoes)
(End)
        `.trim();

        // Make the API Call
        const musicResult = await musicModel.generateContent(songPrompt);
        
        console.log("✅ Response received! Processing files silently...");

        try {
            // Safely grab the parts using optional chaining (?.)
            // This prevents the script from crashing if Google returns an empty response
            const parts = musicResult?.response?.candidates?.[0]?.content?.parts || [];
            
            if (parts.length === 0) {
                console.error("❌ No content parts found. The model may have returned an empty response or hit a safety filter. Here is the raw output:");
                console.log(JSON.stringify(musicResult.response, null, 2));
                return; // Stop execution here
            }
            
            // 1. EXTRACT AND SAVE ALL METADATA TEXT
            const allTextParts = parts.filter(p => p.text).map(p => p.text).join('\n\n=== METADATA ===\n\n');
            if (allTextParts) {
                const textOutputPath = path.join(OUTPUT_DIR, 'synthwave_metadata.txt');
                fs.writeFileSync(textOutputPath, allTextParts);
                console.log(`📝 Lyrics and structural metadata saved to ${textOutputPath}`);
            }

            // 2. EXTRACT AND SAVE THE AUDIO
            const audioPart = parts.find(p => p.inlineData);
            if (audioPart) {
                const base64Audio = audioPart.inlineData.data;
                const audioOutputPath = path.join(OUTPUT_DIR, 'synthwave_track.mp3');
                fs.writeFileSync(audioOutputPath, Buffer.from(base64Audio, 'base64'));
                console.log(`🎵 Audio successfully saved to ${audioOutputPath}`);
            } else {
                console.error("❌ Audio generation succeeded, but no inlineData was found in the response.");
            }

            // 3. CREATE AND SAVE THE SLIM JSON (The Bulletproof Way)
            // The replacer function automatically scrubs any huge base64 strings 
            // no matter where Google hides them in the object.
            const slimJsonString = JSON.stringify(musicResult.response, (key, value) => {
                if (key === 'data' && typeof value === 'string' && value.length > 1000) {
                    return "[BASE64_AUDIO_DATA_REMOVED_FOR_BREVITY]";
                }
                return value;
            }, 2);

            const jsonOutputPath = path.join(OUTPUT_DIR, 'synthwave_slim.json');
            fs.writeFileSync(jsonOutputPath, slimJsonString);
            console.log(`💾 Slim JSON saved to ${jsonOutputPath}`);

        } catch (parseError) {
            console.error("❌ Error parsing the response object:", parseError.message);
        }

    } catch (error) {
        console.error("\n❌ API Connection Error:");
        console.error(error.message);
    }
}

testSynthwaveAudio();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');

// Initialize the API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY1);

// Ensure the output directory exists
const OUTPUT_DIR = path.join(__dirname, 'media_out');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

async function testProAudioGeneration() {
    console.log("Starting Pro Audio Generation Test...\n");
    
    if (!process.env.GEMINI_API_KEY1) {
        console.error("❌ Error: GEMINI_API_KEY1 is not set in your environment.");
        return;
    }
    
    console.log("Using API Key starting with:", process.env.GEMINI_API_KEY1.substring(0, 8));

    try {
        console.log("\nSending structured prompt to Lyria Pro...");
        const musicModel = genAI.getGenerativeModel({ model: "lyria-3-pro-preview" });
        
        // A structured prompt mimicking what your vertical_thread script might generate
        const songPrompt = `
[Genre: Baroque Harpsichord Pop]
[Tempo: Fast, Energetic]

[Intro]
(Bright, cascading harpsichord arpeggios)

[Verse 1]
We built the circuits in the dark
A spark of light to leave a mark
The gears are turning, spinning fast
A future built upon the past

[Chorus]
Oh, the logic flows like a silver stream
Waking up the world from a quiet dream
Listen to the math, listen to the code
Walking down this brand new road

[Outro]
(Fading harpsichord trills)
(End)
        `.trim();

        // Make the API Call
        const musicResult = await musicModel.generateContent(songPrompt);
        
        console.log("\n✅ Response received!");

        // // 1. CONSOLE LOG THE RAW JSON FIRST
        // console.log("\n=== RAW RESPONSE START ===");
        // console.log(JSON.stringify(musicResult.response, null, 2));
        // console.log("=== RAW RESPONSE END ===\n");
        
        // 2. SAVE THE RAW JSON TO A FILE (Just in case the terminal buffer truncates)
        const jsonOutputPath = path.join(OUTPUT_DIR, 'test_audio_pro_raw.json');
        fs.writeFileSync(jsonOutputPath, JSON.stringify(musicResult.response, null, 2));
        console.log(`💾 Raw JSON saved to ${jsonOutputPath}`);

        try {
            const parts = musicResult.response.candidates[0].content.parts;
            
// Extract ALL text parts and join them with a double newline
const allTextParts = parts.filter(p => p.text).map(p => p.text).join('\n\n=== METADATA ===\n\n');

if (allTextParts) {
    const textOutputPath = path.join(OUTPUT_DIR, 'audio_metadata.txt');
    fs.writeFileSync(textOutputPath, allTextParts);
    console.log("📝 All lyrics and metadata saved!");
}

            // 4. EXTRACT AND SAVE THE AUDIO
            const audioPart = parts.find(p => p.inlineData);
            if (audioPart) {
                const base64Audio = audioPart.inlineData.data;
                const audioOutputPath = path.join(OUTPUT_DIR, 'test_audio_pro.mp3');
                fs.writeFileSync(audioOutputPath, Buffer.from(base64Audio, 'base64'));
                console.log(`🎵 Audio successfully saved to ${audioOutputPath}`);
            } else {
                console.error("❌ Audio generation succeeded, but no inlineData was found in the response.");
            }

        } catch (parseError) {
            console.error("❌ Error parsing the response object:", parseError.message);
        }

    } catch (error) {
        console.error("\n❌ API Connection Error:");
        console.error(error.message);
    }
}

testProAudioGeneration();
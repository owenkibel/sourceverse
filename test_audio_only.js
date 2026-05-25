const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');

// Initialize the API with your environment variable
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY1);

// Ensure the output directory exists
const OUTPUT_DIR = path.join(__dirname, 'media_out');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

async function testAudioGeneration() {
    console.log("Starting Audio Generation Test...\n");
    
    // Safety check for the key
    if (!process.env.GEMINI_API_KEY1) {
        console.error("❌ Error: GEMINI_API_KEY1 is not set in your environment.");
        return;
    }
    
    console.log("Using API Key starting with:", process.env.GEMINI_API_KEY1.substring(0, 8));

    try {
        console.log("\nSending prompt to Lyria...");
        const musicModel = genAI.getGenerativeModel({ model: "lyria-3-clip-preview" });
        
        // Make the API Call
        const musicResult = await musicModel.generateContent(
            "A fast-paced, cheerful harpsichord arpeggio in the style of a Baroque prelude."
        );
        
        console.log("✅ Response received! Extracting audio payload...");
        
        // Safely attempt to parse the audio data
        try {
            // Dynamically find whichever part contains the inlineData
            const parts = musicResult.response.candidates[0].content.parts;
            const audioPart = parts.find(p => p.inlineData);
            
            if (audioPart) {
                const base64Audio = audioPart.inlineData.data;
                
                // Save as .mp3 because the mimeType is audio/mpeg
                const outputPath = path.join(OUTPUT_DIR, 'test_audio.mp3');
                fs.writeFileSync(outputPath, Buffer.from(base64Audio, 'base64'));
                
                console.log(`\n🎉 SUCCESS: Audio saved to ${outputPath}`);
                
                // Print the metadata caption Lyria generated
                const textPart = parts.find(p => p.text && p.text.includes("Caption:"));
                if (textPart) {
                    console.log(`\n🎵 Model Metadata:\n${textPart.text}`);
                }
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

testAudioGeneration();
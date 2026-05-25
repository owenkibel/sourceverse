// test_google_media.js
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');

// Ensure your key is exported in your shell before running
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY1);

const OUTPUT_DIR = path.join(__dirname, 'media_out');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

async function testEconomicalGeneration() {
    console.log("Starting economical media generation test...\n");

    try {
        // ==========================================
        // 1. IMAGE GENERATION
        // ==========================================
        console.log("Generating Image...");
        // HIGH QUALITY: const imageModelName = "gemini-3-pro-image-preview";
        const imageModelName = "gemini-3.1-flash-image-preview"; // Nano Banana Fast
        
        const imageModel = genAI.getGenerativeModel({ model: imageModelName });
        const imageResult = await imageModel.generateContent(
            "An allegorical oil painting of a mechanical spider navigating a maze of old books, humorous and lighthearted."
        );
        
        const base64Image = imageResult.response.candidates[0].content.parts[0].inlineData.data;
        fs.writeFileSync(
            path.join(OUTPUT_DIR, 'test_image.png'), 
            Buffer.from(base64Image, 'base64')
        );
        console.log("✅ Image saved to media_out/test_image.png");

        // ==========================================
        // 2. VIDEO GENERATION
        // ==========================================
        console.log("\nGenerating Video snippet...");
        // HIGH QUALITY: const videoModelName = "veo-3-generate-001";
        const videoModelName = "veo-3.1-lite-generate-preview";
        
        const videoModel = genAI.getGenerativeModel({ model: videoModelName });
        const videoResult = await videoModel.generateContent(
            "Cinematic, low-light footage of a vintage pocket watch ticking backwards, soft focus."
        );
        
        const base64Video = videoResult.response.candidates[0].content.parts[0].inlineData.data;
        fs.writeFileSync(
            path.join(OUTPUT_DIR, 'test_video.mp4'), 
            Buffer.from(base64Video, 'base64')
        );
        console.log("✅ Video saved to media_out/test_video.mp4");

        // ==========================================
        // 3. MUSIC GENERATION
        // ==========================================
        console.log("\nGenerating Audio clip...");
        // HIGH QUALITY: const musicModelName = "lyria-3-pro-preview";
        const musicModelName = "lyria-3-clip-preview"; 
        
        const musicModel = genAI.getGenerativeModel({ model: musicModelName });
        const musicResult = await musicModel.generateContent(
            "A fast-paced, cheerful harpsichord arpeggio in the style of a Baroque prelude."
        );
        
        const base64Audio = musicResult.response.candidates[0].content.parts[0].inlineData.data;
        fs.writeFileSync(
            path.join(OUTPUT_DIR, 'test_audio.wav'), 
            Buffer.from(base64Audio, 'base64')
        );
        console.log("✅ Audio saved to media_out/test_audio.wav");

    } catch (error) {
        console.error("\n❌ API Error Encountered:");
        console.error(error.message);
    }
}

testEconomicalGeneration();
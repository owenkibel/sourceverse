const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');

// Initialize the API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY1);

// Ensure output directory exists
const OUTPUT_DIR = path.join(__dirname, 'media_out');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

async function testImageGeneration() {
    console.log("Starting Image Generation Test...\n");
    
    if (!process.env.GEMINI_API_KEY1) {
        console.error("❌ Error: GEMINI_API_KEY1 is not set in your environment.");
        return;
    }
    
    console.log("Using API Key starting with:", process.env.GEMINI_API_KEY1.substring(0, 8));

    try {
        console.log("\nSending prompt to Flash Image...");
        // Define the image model
        const imageModel = genAI.getGenerativeModel({ model: "gemini-3.1-flash-image-preview" });
        
        // Make the API Call
        const imageResult = await imageModel.generateContent(
            "A hyper-realistic photograph of an antique telescope sitting on a wooden desk, surrounded by glowing star charts."
        );
        
        console.log("✅ Response received! Extracting image payload...");
        
        try {
            // Dynamically find the part containing the image data
            const parts = imageResult.response.candidates[0].content.parts;

            const allTextParts = parts.filter(p => p.text).map(p => p.text).join('\n\n');
if (allTextParts.trim() !== '') {
    console.log(`📝 Image Metadata/Rewrites:\n${allTextParts}`);
}

            const imagePart = parts.find(p => p.inlineData);
            
            if (imagePart) {
                const base64Image = imagePart.inlineData.data;
                const mimeType = imagePart.inlineData.mimeType;
                
                // Determine the correct file extension
                const ext = mimeType.includes('png') ? 'png' : 'jpg';
                const outputPath = path.join(OUTPUT_DIR, `test_image.${ext}`);
                
                fs.writeFileSync(outputPath, Buffer.from(base64Image, 'base64'));
                console.log(`\n🎉 SUCCESS: Image saved to ${outputPath}`);
            } else {
                console.error("❌ Image generation succeeded, but no inlineData was found in the response.");
            }

        } catch (parseError) {
            console.error("❌ Error parsing the response object:", parseError.message);
        }

    } catch (error) {
        console.error("\n❌ API Connection Error:");
        console.error(error.message);
    }
}

testImageGeneration();
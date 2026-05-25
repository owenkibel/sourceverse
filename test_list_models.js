const apiKey = process.env.GEMINI_API_KEY1;

if (!apiKey) {
    console.error("❌ Error: GEMINI_API_KEY1 is not set in your environment.");
    process.exit(1);
}

async function checkAuthorizedModels() {
    console.log("🔍 Querying Google's backend for your authorized models...\n");

    try {
        // Ping the raw REST API endpoint
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        
        if (!response.ok) {
            throw new Error(`API returned HTTP status: ${response.status}`);
        }
        
        const data = await response.json();
        const models = data.models || [];
        
        console.log(`✅ Successfully retrieved ${models.length} models. Scanning roster...\n`);

        // Filter and display the roster
        models.forEach(model => {
            const name = model.name;
            const methods = model.supportedGenerationMethods ? model.supportedGenerationMethods.join(', ') : 'None';
            
            // Highlight media/experimental models
            if (name.includes('veo') || name.includes('lyria') || name.includes('imagen') || name.includes('audio') || name.includes('video')) {
                console.log(`🎬 MEDIA MODEL: ${name}`);
                console.log(`   Methods: ${methods}`);
                console.log('   --------------------------------------------------');
            } else {
                // Print standard text models normally
                console.log(`   Standard: ${name}`);
            }
        });

        // Quick summary check for Veo
        const hasVeo = models.some(m => m.name.includes('veo'));
        if (!hasVeo) {
            console.log("\n⚠️ VERDICT: There are NO 'veo' models currently bound to your API key.");
            console.log("Google often puts high-compute video models behind an early-access allowlist or restricts them to Enterprise Vertex AI accounts before opening them to developer Postpay accounts.");
        } else {
            console.log("\n🎉 VERDICT: Veo IS in your roster! Check the exact spelling above and ensure the 'Method' matches generateContent.");
        }

    } catch (error) {
        console.error("❌ Fetch failed:", error.message);
    }
}

checkAuthorizedModels();
#!/usr/bin/env bun
import { writeFileSync } from 'fs';
import { join } from 'path';

// 1. Re-integrate and evaluate the command-line switches
const args = process.argv.slice(2);
const useGeminiImage = args.includes('--gemini-image');

if (!useGeminiImage) {
  console.error("Error: Execution halted. You must include the '--gemini-image' switch flag.");
  console.log("Usage: bun generate-banana.js --gemini-image \"Your intricate baroque prompt here\"");
  process.exit(1);
}

// 2. Extract input text payload by dropping the switch element
const promptText = args.filter(arg => arg !== '--gemini-image').join(' ');

if (!promptText.trim()) {
  console.error("Error: Please provide a prompt string after the switch.");
  process.exit(1);
}

// Fixed environment key tracking variable property mapping
const API_KEY = process.env.GEMINI_API_KEY1;
if (!API_KEY) {
  console.error("Error: Environment variable GEMINI_API_KEY1 is not set.");
  process.exit(1);
}

async function executeInference() {
  console.log(`Initializing Nano Banana 2 Lite [gemini-3.1-flash-lite-image]...`);
  console.log(`Prompt: "${promptText}"\n`);

  // Corrected native multimodal endpoint routing signature
  const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-image:generateContent?key=${API_KEY}`;

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: promptText }
            ]
          }
        ],
        generationConfig: {
          // Explicitly instruct the model to return inline media layout tokens
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: {
            aspectRatio: "1:1"
          }
        }
      })
    });

    if (!response.ok) {
      const errorPayload = await response.text();
      throw new Error(`API Connection Failed (${response.status}): ${errorPayload}`);
    }

    const data = await response.json();
    
    // Parse the unified generateContent candidates schema tree 
    let base64Bytes = null;
    const parts = data.candidates?.[0]?.content?.parts || [];
    
    for (const part of parts) {
      if (part.inlineData && part.inlineData.data) {
        base64Bytes = part.inlineData.data;
        break;
      }
    }

    if (!base64Bytes) {
      throw new Error("Inference completed, but no inline image data block was found in the response payload structural nodes.");
    }

    // 3. Output structural asset locally
    const fileId = `snapshot-${Date.now()}.jpg`;
    const destination = join(process.cwd(), fileId);

    writeFileSync(destination, Buffer.from(base64Bytes, 'base64'));
    
    console.log(`--------------------------------------------------`);
    console.log(`⚡ Render Complete (~4 seconds @ $0.034 per asset)`);
    console.log(`💾 Saved to disk: ${destination}`);
    console.log(`--------------------------------------------------`);

  } catch (err) {
    console.error("Execution error during image compilation:", err.message);
  }
}

executeInference();
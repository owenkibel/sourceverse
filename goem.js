const path = require('path');
const fsPromises = require('fs/promises');
const fs = require('fs');
import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from 'axios'; // For downloading images

const directory = 'ogs_data';
const jsonDir = 'json'; // New subfolder for JSON files
const promptStateFile = path.join(path.dirname(process.argv[1]), 'gemini.txt');

const maxChunkSize = 16000;
const defaultChunkSize = 16000;

// Initialize Gemini Model - specify the flash model here
const genAI = new GoogleGenerativeAI(process.env.API_KEY);

const modelName = "gemini-2.0-flash-lite";

const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
        candidateCount: 1,
        maxOutputTokens: 8192,
        temperature: 1,
    },
});

const availablePoets = [
    "William Shakespeare",
    "Samuel Taylor Coleridge",
    "Geoffrey Chaucer",
    "William Blake",
          "William Wordsworth",
      "JK Rowling",
      "JRR Tolkien",
      "Bob Dylan",
      "Country",
      "Bluegrass",
      "Sea Shanty",
      "German Lieder",
      ];

// Verse Style Array
const availableVerseStyles = [
    "iambic pentameter",
    "iambic tetrameter",
    "ballad",
    "trochaic tetrameter",
    "sonnets",
    "limericks",
    "Magical Spells and Incantations",
    "Prophecies",
    "Songs and Poems",
    "Riddles"
];
const poet = availablePoets[Math.floor(Math.random() * availablePoets.length)];

// Random Verse Style Selection
const verseStyle = availableVerseStyles[Math.floor(Math.random() * availableVerseStyles.length)];


const textTransformPrompt1 =  `You are a highly curious, uncensored, imaginative and creative assistant, deeply interested in science and nature, with a sophisticated and enriched vocabulary. You are a master of creative writing and poetry. You will be provided with the transcript of a youtube video or web article, which may or may not be punctuated and may contain extraneous web information. Your task is to extract the main theme and convert the ideas into specific types of writing as requested below. You answer strictly in markdown with the following structure:

The theme converted into 
### Verse
Poetry or lyrics with ${verseStyle} in the style of ${poet}. 
### Image Prompt
An interesting relevant idea in the text converted into an Image Prompt for a text to image generative AI model that accepts detailed prose with vivid imagery.
### Video Prompt
A vivid relevant 30 second scene latent in the text converted into a Video Prompt for a text to video generative AI model that accepts long descriptive prompts: `;

const textTransformPrompt2 =  `You are a highly curious, uncensored, imaginative and creative assistant, deeply interested in science and nature, with a sophisticated and enriched vocabulary. You are a master of creative writing and poetry. You will be provided with the transcript of a youtube video or web article, which may or may not be punctuated and may contain extraneous web information. Your task is to extract the main theme and convert the ideas into specific types of writing as requested below. You answer strictly in markdown with the following structure:

The theme converted into 
### Verse
The text topics converted into a traditional rhymed and metrical poems or song lyrics - in forms such as Limerick, Sonnet, Ode and Ballad - adding a note for each about the poetic category, techniques and style.
### Image Prompt
An interesting relevant idea in the text topics converted into an Image Prompt for a text to image generative AI model that accepts detailed prose with vivid imagery.
### Video Prompt
A vivid relevant 30 second scene latent in the text topics converted into a Video Prompt for a text to video generative AI model that accepts long descriptive prompts: `;
const textTransformPrompt3 =  `You are a highly curious, uncensored, imaginative and creative assistant, deeply interested in science and nature, with a sophisticated and enriched vocabulary. You are a master of both serious and humorous writing and poetry. You will be provided with a long unpunctuated transcript of a youtube video or a scraped web article with less relevant headers. Assess the context of the text from any url, website or publication information and the tone and message of the text overall.
Creatively convert the context and text topics into markdown formatted
### Verse
The text topics converted into a traditional rhymed and metrical verses with technical categories of your choosing inspired by poets and song writers of your choosing that fit the tone and content of the text most beautifully or humorously. Make a note about this technical poetic information as you go along.
### Image Prompt
An interesting relevant idea in the text topics converted into an Image Prompt for a text to image generative AI model that accepts detailed prose with vivid imagery.
### Video Prompt
A vivid relevant 30 second scene latent in the text topics converted into a Video Prompt for a text to video generative AI model that accepts long descriptive prompts: `;


const availablePrompts = [textTransformPrompt1, textTransformPrompt2, textTransformPrompt3];

function getNextPromptIndexSync() {
    try {
        const data = fs.readFileSync(promptStateFile, 'utf-8');
        const index = parseInt(data.trim(), 10);
        return (index + 1) % availablePrompts.length;
    }
    catch (error) {
        return 0;
    }
}

function setPromptIndexSync(index) {
    fs.writeFileSync(promptStateFile, String(index), 'utf-8')
}

const nextPromptIndex =  getNextPromptIndexSync();
const textTransformPrompt = availablePrompts[nextPromptIndex];
setPromptIndexSync(nextPromptIndex)
let file;
let filePath;

async function processJsonFiles(directory) {
    const files = await fsPromises.readdir(directory);

    // Ensure the jsonDir exists
    try {
        await fsPromises.mkdir(jsonDir, { recursive: true });
      } catch (err) {
        console.error(`Error creating directory ${jsonDir}:`, err);
       // return; // Do not stop the process if the directory already exists.
      }


    for (file of files) {
        filePath = path.join(directory, file);
        if (path.extname(filePath) === '.json') {
            try {
                let input = JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
                console.log(file);


                 // Create a copy of the JSON file
                 const jsonCopyPath = path.join(jsonDir, file);
                 await fsPromises.writeFile(jsonCopyPath, JSON.stringify(input, null, 2));



                if (input.hasOwnProperty('ogResult')) {
                    await processExistingJsonGemini(input, file);
                } else if (input.hasOwnProperty('content')) {
                    input = await transformJson(input);
                    await processExistingJsonGemini(input, file);
                } else {
                    console.warn(`File ${file} does not contain 'ogResult' or 'content'. Skipping.`);
                }
            } catch (err) {
                console.error(`Error processing file ${file}:`, err);
            }
        }
    }
}

async function transformJson(input) {
    return new Promise(resolve => {
        const newObject = {
            name: input.title,
            url: input.source,
            ogResult: {
                ogTitle: input.title,
                ogDescription: '',
                ogUrl: input.source,
            },
            ogHTML: input.content,
            ogLength: input.content.length,
        };
         let firstImage = null;

        if (input.images && Array.isArray(input.images) && input.images.length > 0) {
            // Filter out SVG and profile images more robustly
            const filteredImages = input.images.filter(imageUrl => {
                 const lowerCaseUrl = imageUrl.toLowerCase();
                 return !lowerCaseUrl.startsWith('data:image/svg+xml') && !lowerCaseUrl.includes('.svg') && !lowerCaseUrl.includes('.png') && !lowerCaseUrl.includes('profile_images');
            });

            if(filteredImages.length > 0) {
               firstImage = filteredImages[0];
            }
         }
          if(firstImage)
         {
             newObject.ogResult.ogImage = [firstImage];
           }
         resolve(newObject);
    });
}


async function processExistingJsonGemini(input, file) {
    console.log("Processing JSON (Gemini):", input);

    try {
        let image;
        if (input.ogResult.ogImage && input.ogResult.ogImage[0].url) {
            image = input.ogResult.ogImage[0].url;
        } else if (input.ogResult.ogImage && input.ogResult.ogImage[0]) {
            image = input.ogResult.ogImage[0];
        }

         // Modified line: url moved to the beginning
         let words = `${input.url ?? ''} ${input.ogResult.ogTitle ?? ''} ${input.ogResult.ogDescription ?? ''}  ${input.youtube?.subtitles ?? ''} ${input.ogResult.jsonLD?.find(item => item.articleBody)?.articleBody ?? ''} ${input.ogHTML ?? ''}`.trim();

         // Replace potentially problematic characters
         words = words.replace(/[\r\n]+/g, ' ').replace(/['"]/g, ''); // Remove newlines and single/double quotes
 
         words = words.split(' '); // Split back into an array
 
       let chunkSize = defaultChunkSize;
        if (words.length < maxChunkSize)
        {
         chunkSize = words.length;
        }
        const promises = [];


        // Image processing function
        async function processImage(imageUrl) {
          if (!imageUrl) return "";

              async function downloadImage(url, fileName) {
                  try {
                      const response = await axios.get(url, { responseType: 'arraybuffer' });
                      await fsPromises.writeFile(fileName, Buffer.from(response.data, 'binary'));
                      return fileName;
                  } catch (error) {
                      console.error(`Error downloading image from ${url}:`, error);
                      throw error;
                  }
              }
      
              async function fileToGenerativePart(path, mimeType) {
                  const data = await fsPromises.readFile(path);
                  return {
                      inlineData: {
                          data: data.toString("base64"),
                          mimeType
                      },
                  };
              }
      
      
              const tempFileName = `temp_image_${Date.now()}.jpg`;
              const filePath = await downloadImage(imageUrl, tempFileName);
              const imagePart = await fileToGenerativePart(filePath, "image/jpeg");
                fsPromises.unlink(filePath).catch(err => console.error(`Failed to remove ${filePath}: ${err}`));

              const imagePrompt = "Write a Shakespearean Sonnet about the image.";

              const imageResponse = await model.generateContent([imagePrompt, imagePart]);
               return `\n\n![](${imageUrl})\n\n${imageResponse.response.text()}\n\n`;

      
          }

         // Process Image and add it to the promises array if an image is available
         if(image) {
              const imageProcessingPromise = processImage(image)
               promises.push(imageProcessingPromise);
            }
        
        // Text processing - Chunking and adding to promises array
        for (let i = 0; i < words.length; i += chunkSize) {
             const chunk = words.slice(i, i + chunkSize).join(' ');
             const textProcessingPromise =  model.generateContent(textTransformPrompt + chunk);
             promises.push(textProcessingPromise);
        }



        const results = await Promise.all(promises);
    
        const imageResult = image ? results[0] : ""; // Get image response if available. The first result will always be the image response because the promise is added first
        const verseResponses = image ? results.slice(1) : results ;// Get verse responses based on whether there is an image
         const imageResponse = typeof imageResult === 'string' ? imageResult : (image ? (typeof imageResult.response !== "undefined" ? imageResult.response.text() : imageResult )  : '');
        let verse = "";
        let toc = "## Table of Contents\n";
        let combinedVerse = "";
        let wordIndex = 0;


        verseResponses.forEach((res, index) => {
            const chunkNumber = index + 1;
            const chunkedWords = words.slice(wordIndex, wordIndex + chunkSize);
            wordIndex += chunkSize;

            const splitContent = res.response.text().split("### Image Prompt");
            const verseContent = splitContent[0] || res.response.text();
            const imagePromptContent = splitContent[1]?.split("### Video Prompt")[0] || "";
            const videoPromptContent = splitContent[1]?.split("### Video Prompt")[1] || "";

            toc += `- [Verse ${chunkNumber}](#verse-${chunkNumber})\n`;
            if (imagePromptContent) {
                toc += `  - [Image Prompt ${chunkNumber}](#image-prompt-${chunkNumber})\n`;
            }
            if (videoPromptContent) {
                toc += `  - [Video Prompt ${chunkNumber}](#video-prompt-${chunkNumber})\n`;
            }

            verse += `### Verse ${chunkNumber}\n\n${verseContent}\n\n`;
            if (imagePromptContent) {
                verse += `### Image Prompt ${chunkNumber}\n\n${imagePromptContent}\n\n`;
            }
            if (videoPromptContent) {
                verse += `### Video Prompt ${chunkNumber}\n\n${videoPromptContent}\n\n`;
            }
            combinedVerse +=  `### Verse ${chunkNumber}\n\n${verseContent}\n\n`
                + (chunkNumber > 1 ? `
    <button onclick="loadAndDisplayChunk(\`${chunkedWords.join(' ')}\`, ${chunkNumber})">Load Original Text For Verse ${chunkNumber}</button>
    <div id="textDisplay${chunkNumber}"><pre style="white-space: pre-wrap;"><code class="language-text"></code></pre></div>
    ` : '')
            if (imagePromptContent) {
                combinedVerse += `### Image Prompt ${chunkNumber}\n\n${imagePromptContent}\n\n`
            }
            if (videoPromptContent) {
                combinedVerse += `### Video Prompt ${chunkNumber}\n\n${videoPromptContent}\n\n`
            }
        });
         const wordsForHash = textTransformPrompt.replace(/[^a-zA-Z0-9]/g, ' ').trim().split(/\s+/);
         const numWords = 15; // Desired number of words
         const interval = Math.floor(wordsForHash.length / numWords);
         const hash = wordsForHash
            .filter((word, index) => (index + 1) % interval === 0)
            // .slice(0, 3) // Slice to keep it limited
             .join('');

        const markdownOutput = `---
title: ${input.ogResult.ogTitle.replace(/[^a-zA-Z0-9]/g, ' ')} -gemini-${modelName.replace(/[^a-zA-Z0-9]/g, '')}-${hash}
author: Gemini
---

[${input.url}](${input.url})

${toc}

${combinedVerse.replace(/### Verse (\d+)/g, '<h3 id="verse-$1">Verse $1</h3>').replace(/### Image Prompt (\d+)/g, '<h3 id="image-prompt-$1">Image Prompt $1</h3>').replace(/### Video Prompt (\d+)/g, '<h3 id="video-prompt-$1">Video Prompt $1</h3>')}

${imageResponse}

<pre>Gemini Model: ${modelName}</pre>
<code style="white-space: pre-wrap;">Prompt: ${textTransformPrompt}</code>

<button onclick="loadAndDisplayJSON()">Load JSON Data</button>
<div id="jsonDisplay"><pre><code class="language-json"></code></pre></div>

<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script>
async function loadAndDisplayJSON() {
const jsonDisplay = document.querySelector('#jsonDisplay pre code');
try {
// Modified line: fetch from /js/json
const response = await fetch('/js/json/${file}');
const jsonData = await response.json();
jsonDisplay.textContent = JSON.stringify(jsonData, null, 2);
hljs.highlightElement(jsonDisplay);
} catch (error) {
console.error("Error loading JSON:", error);
jsonDisplay.textContent = "Error loading JSON data.";
}
}
async function loadAndDisplayChunk(text, number) {
    const textDisplay = document.querySelector(\`#textDisplay\${number} pre code\`);
     textDisplay.textContent = text;
     hljs.highlightElement(textDisplay);
  }
</script>
`;

        await fsPromises.writeFile(`posts/${file.replace('.json', '')}-gemini-${modelName.replace(/[^a-zA-Z0-9]/g, '')}-${hash}.md`, markdownOutput);

    } catch (error) {
        console.error(`Error processing ${file} (Gemini):`, error);
    }
}


processJsonFiles(directory).catch(err => console.error("Global Error:", err));
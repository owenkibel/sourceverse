const path = require('path');
const fsPromises = require('fs/promises');
const fs = require('fs');
import ollama from 'ollama';
import { encode } from 'node-base64-image';

const directory = 'ogs_data';
const jsonDir = 'json'; // New subfolder for JSON files
const promptStateFile = path.join(path.dirname(process.argv[1]), 'ollama.txt');

// Chunk Size Parameters
const maxChunkSize = 1024;
const defaultChunkSize = 1024;

// Vision Model Array (hardcoded)
const availableVisionModels = [
    'minicpm-v:latest',
    'llama3.2-vision:latest'
];

// Poet/Songwriter Array
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

let availableModels = [];
async function getAvailableModels() {
    try {
        const modelList = await ollama.list()
        availableModels = modelList.models.map(model => model.name);
        const ineligibleModels = ["verse:latest", "nomic-embed-text:latest", "minicpm-v:latest", "llama3.2-vision:latest", "deepseek-r1:latest", "deepseek-r1:8b-llama-distill-q4_K_M", "erwan2/DeepSeek-Janus-Pro-7B:latest"];

        // Filter out ineligible models
        availableModels = availableModels.filter(model => !ineligibleModels.includes(model));
    }
    catch (error) {
        console.error("Error getting Ollama Model List:", error);
    }
}
await getAvailableModels()

// Random Model Selection
const model = availableModels[Math.floor(Math.random() * availableModels.length)];
const modelShortName = model.split('/').pop().split(':')[0].replace(/[^a-zA-Z0-9]/g, '');

// Random Vision Model Selection
const model1 = availableVisionModels[Math.floor(Math.random() * availableVisionModels.length)];

// Random Poet Selection
const poet = availablePoets[Math.floor(Math.random() * availablePoets.length)];

// Random Verse Style Selection
const verseStyle = availableVerseStyles[Math.floor(Math.random() * availableVerseStyles.length)];

const modelfile1 = `
FROM ${model}
PARAMETER temperature 1
PARAMETER num_ctx 8192
SYSTEM "You are a highly curious, uncensored, imaginative, creative assistant, deeply interested in science and nature, with a sophisticated and enriched vocabulary. You are a master of both serious and humorous writing and poetry. Respond to user requests to the best of your ability."
`;

// Modified ollama.create with from parameter
await ollama.create({ model: 'verse', modelfile: modelfile1, from: model });

const textTransformPrompt1 =  `The following text is a long transcript of a youtube video or a scraped web article that may have extraneous website information. The text may be or may not be punctuated.
Creatively distill from the text topics - the following types of poems and AI prompts, answering in markdown with -
### Verse
Poetry or lyrics with ${verseStyle} in the style of ${poet}. 
### Image Prompt
An interesting relevant idea in the text converted into an Image Prompt for a text to image generative AI model that accepts detailed prose with vivid imagery.
### Video Prompt
A vivid relevant scene latent in the text converted into a Video Prompt for a text to video generative AI model that accepts long descriptive prompts: `;

const textTransformPrompt2 =  `The following text is a long transcript of a youtube video or a scraped web article that may have extraneous website information. The text may be or may not be punctuated.
Creatively distill from the text topics - the following types of poems and AI prompts, answering in markdown with -
### Verse
The text topics converted into a traditional rhymed and metrical poems or song lyrics - in forms such as Limerick, Sonnet, Ode and Ballad - adding a note for each about the poetic category, techniques and style.
### Image Prompt
An interesting relevant idea in the text topics converted into an Image Prompt for a text to image generative AI model that accepts detailed prose with vivid imagery.
### Video Prompt
A vivid relevant 30 second scene latent in the text topics converted into a Video Prompt for a text to video generative AI model that accepts long descriptive prompts: `;

const textTransformPrompt3 =  `The following text is a long unpunctuated transcript of a youtube video or a scraped web article with less relevant headers. Assess the context of the text from any url, website or publication information and the tone and message of the text overall.
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

const imagep = 'Describe this image in the form of a Shakespearean sonnet:';

async function processVisionResponse(image, model1, imagep) {
    if (!image) return "";
    try{
        const result1 = await encode(image);
         const imagePrompt = await ollama.chat({
           model: model1,
           messages: [{ role: 'user', content: imagep, images: [result1] }]
          });
         return `![](${image})${imagePrompt.message.content}`;
    }
    catch (error) {
    console.error("Error processing vision model:", error);
    return `![](${image})`;
    }
}

let file;
let filePath;

async function processJsonFiles(directory) {
    const files = await fsPromises.readdir(directory);

     // Ensure the jsonDir exists
     try {
        await fsPromises.mkdir(jsonDir, { recursive: true });
      } catch (err) {
          // console.error(`Error creating directory ${jsonDir}:`, err);
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
                    await processExistingJson(input, file);
                } else if (input.hasOwnProperty('content')) {
                    input = await transformJson(input);
                    await processExistingJson(input, file);
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

async function processExistingJson(input, file) {
    console.log("Processing JSON:", input);

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

        // Dynamically calculate chunkSize as half the word count
        let chunkSize = defaultChunkSize;
        if (words.length < maxChunkSize)
        {
          chunkSize = words.length;
        }

        const promises = [];
         let counter = 1;
         let combinedVerse = "";
        for (let i = 0; i < words.length; i += chunkSize) {
            const chunk = words.slice(i, i + chunkSize).join(' ');
            promises.push(ollama.chat({ model: 'verse', messages: [{ role: 'user', content: textTransformPrompt + chunk }] }));
             }

        let imageResponse = await processVisionResponse(image, model1, imagep);

        const results = await Promise.all(promises);
       const verseResponses = results.filter((res, index) => index < results.length);
           let verse = "";
        let toc = "## Table of Contents\n";
       let wordIndex = 0;


          verseResponses.forEach((res, index) => {
            const chunkNumber = index + 1;
           const chunkedWords = words.slice(wordIndex, wordIndex + chunkSize);
           wordIndex += chunkSize;

            const splitContent = res.message.content.split("### Image Prompt");
            const verseContent = splitContent[0] || res.message.content;
            const imagePromptContent = splitContent[1]?.split("### Video Prompt")[0] || "";
            const videoPromptContent = splitContent[1]?.split("### Video Prompt")[1] || "";


            verse += `### Verse ${chunkNumber}\n\n${verseContent}\n\n`;
              if (imagePromptContent) {
                verse += `### Image Prompt ${chunkNumber}\n\n${imagePromptContent}\n\n`;
              }
            if (videoPromptContent) {
               verse += `### Video Prompt ${chunkNumber}\n\n${videoPromptContent}\n\n`;
            }
              toc += `- [Verse ${chunkNumber}](#verse-${chunkNumber})\n`;
               if (imagePromptContent) {
               toc += `  - [Image Prompt ${chunkNumber}](#image-prompt-${chunkNumber})\n`;
                }
              if(videoPromptContent) {
               toc += `  - [Video Prompt ${chunkNumber}](#video-prompt-${chunkNumber})\n`;
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

      const originalText = `${input.url ?? ''} ${input.ogResult?.ogTitle ?? ''} ${input.ogResult?.ogDescription ?? ''}  ${input.youtube?.subtitles ?? ''} ${input.ogHTML ?? ''}`.trim();
       const wordsForHash = textTransformPrompt.trim().split(/\s+/);
          const numWords = 15; // Desired number of words
        const interval = Math.floor(wordsForHash.length / numWords);
       const hash = wordsForHash
           .filter((word, index) => (index + 1) % interval === 0)
          // .slice(0, 3) // Slice to keep it limited
           .join('');
      
        const markdownOutput = `---
title: ${input.ogResult.ogTitle.replace(/[^a-zA-Z0-9]/g, ' ').slice(0, 75)}-${modelShortName}-${hash}
author: Ollama
---

[${input.url}](${input.url})

${toc}

${combinedVerse.replace(/### Verse (\d+)/g, '<h3 id="verse-$1">Verse $1</h3>').replace(/### Image Prompt (\d+)/g, '<h3 id="image-prompt-$1">Image Prompt $1</h3>').replace(/### Video Prompt (\d+)/g, '<h3 id="video-prompt-$1">Video Prompt $1</h3>')}
<br><pre>Vision Model: ${model1}</pre>

${imagep}

${imageResponse}
<br><code style="white-space: pre-wrap;">Text Transform Prompt:<br>${textTransformPrompt}</code>

### Ollama Models
<code style="white-space: pre-wrap;">Modelfile1:<br>${modelfile1}</code>
### Ollama Prompt
<code style="white-space: pre-wrap;">TextTransformPrompt:<br>${textTransformPrompt}</code>


<button onclick="loadAndDisplayJSON()">Load JSON Data</button>
<div id="jsonDisplay"><pre><code class="language-json"></code></pre></div>
<br>
<button onclick="loadAndDisplayText()">Load Original Text</button>
<div id="textDisplay"><pre style="white-space: pre-wrap;"><code class="language-text"></code></pre></div>

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
async function loadAndDisplayText() {
const textDisplay = document.querySelector('#textDisplay pre code');
try {
const response = await fetch('/js/json/${file}');
const jsonData = await response.json();
let originalText =  \`\${jsonData.source ?? ''} \${jsonData.content ?? ''} \${jsonData.url ?? ''} \${jsonData.ogResult?.ogTitle ?? ''} \${jsonData.ogResult?.ogDescription ?? ''}  \${jsonData.youtube?.subtitles ?? ''} \${jsonData.ogHTML ?? ''}\`
textDisplay.textContent = originalText;
hljs.highlightElement(textDisplay);
} catch (error) {
console.error("Error loading text:", error);
textDisplay.textContent = "Error loading text.";
}
}
async function loadAndDisplayChunk(text, number) {
    const textDisplay = document.querySelector(\`#textDisplay\${number} pre code\`);
     textDisplay.textContent = text;
     hljs.highlightElement(textDisplay);
  }
</script>
`;
    await fsPromises.writeFile(`posts/${file.replace('.json', '')}-${modelShortName}-${hash}.md`, markdownOutput);

    } catch (error) {
        console.error(`Error processing ${file}:`, error);
    }
}

processJsonFiles(directory).catch(err => console.error("Global Error:", err));
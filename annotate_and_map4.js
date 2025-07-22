const fs = require('fs').promises;
const path = require('path');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const { ANNOTATOR_PROMPT } = require('./balladprompts/annotator_prompt1');

// --- Configuration ---
const POSTS_DIR = 'posts';
const MODEL_NAME = "gemini-2.5-flash"; // Using a powerful model is good for this task
const ANNOTATION_GUARD = "<!-- GEMINI-ANNOTATED -->";
const MINDMAP_LIBRARIAN_SEPARATOR = '---MINDMAP-SEPARATOR---';
const MINDMAP_PHILOSOPHER_SEPARATOR = '---PHILOSOPHER-SEPARATOR---';

// --- Initialize Gemini Client ---
const apiKey = process.env.API_KEY;
if (!apiKey) {
    console.error("FATAL: API_KEY environment variable for Google AI is not set.");
    process.exit(1);
}
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ]
});

/**
 * Helper function to indent a block of markdown text.
 * This is crucial for creating sub-branches in the final mind map.
 * @param {string} text - The markdown text to indent.
 * @param {string} indent - The indentation string, e.g., '  '.
 * @returns {string} The indented markdown text.
 */
function indentMarkdown(text, indent = '  ') {
    if (!text) return '';
    return text.trim().split('\n').map(line => indent + line).join('\n');
}


async function findLatestBookmarksFile() {
    try {
        const files = await fs.readdir(POSTS_DIR);
        const bookmarkFiles = files
            .filter(file => file.startsWith('bookmarks-') && file.endsWith('.md'))
            .sort()
            .reverse();

        for (const file of bookmarkFiles) {
            const filePath = path.join(POSTS_DIR, file);
            const content = await fs.readFile(filePath, 'utf8');
            if (!content.includes(ANNOTATION_GUARD)) {
                console.log(`Found latest un-annotated bookmarks file: ${file}`);
                return filePath;
            }
        }
        console.log("No new, un-annotated bookmark files found.");
        return null;
    } catch (error) {
        console.error(`Error finding latest bookmarks file: ${error.message}`);
        return null;
    }
}

async function parseBookmarksFile(filePath) {
    const fileContent = await fs.readFile(filePath, 'utf8');
    const bookmarks = [];
    const rowRegex = /^\|.*\|$/gm;
    const innerLinkRegex = /(?<!\!)\[(.*?)\]\((.*?)\)/g;

    let rowMatch;
    while ((rowMatch = rowRegex.exec(fileContent)) !== null) {
        const rowContent = rowMatch[0];
        if (rowContent.includes('| Details |') || rowContent.includes('|:---|:---|')) continue;

        let linkMatch;
        innerLinkRegex.lastIndex = 0;
        while ((linkMatch = innerLinkRegex.exec(rowContent)) !== null) {
            const linkUrl = linkMatch[2].trim();
            const linkText = linkMatch[1].trim();
            let fullText = `${linkText}\n${rowContent}`
                .replace(/\|/g, '')
                .replace(/\[.*?\]\(.*?\)/g, '')
                .replace(/<br>/g, '\n')
                .replace(/<\/?[^>]+(>|$)/g, "")
                .replace(/\*\*/g, '')
                .replace(/\s{2,}/g, ' ')
                .trim();
            bookmarks.push({ text: fullText, linkUrl });
        }
    }
    console.log(`Parsed ${bookmarks.length} bookmarks with text and links.`);
    return bookmarks;
}


/**
 * [REWRITTEN FUNCTION]
 * Combines two markdown lists into a single mind map with two main branches.
 */
async function createMindmapPost(librarianMarkdown, philosopherMarkdown, mindmapFilePath, originalPostTitle) {
    // Combine the two markdown strings into a single structure with a root node
    // and two main branches. We use the helper function to indent the content
    // of each map, making them sub-items of the main branches.
    const combinedMindmapMarkdown = `
# Combined Mind Map for ${originalPostTitle}

- **Librarian's Thematic Map**
${indentMarkdown(librarianMarkdown)}

- **Philosopher's Sorting Map**
${indentMarkdown(philosopherMarkdown)}
`.trim();

    // This structure creates a single page with a single Markmap instance,
    // which is compatible with your blog's templating system.
    const mindmapPageContent = `---
layout: layouts/mindmap-layout.vto
title: "Mind Maps for ${originalPostTitle}"
---
<div class="markmap">
  <script type="text/template">
${combinedMindmapMarkdown}
  </script>
</div>
`;

    await fs.writeFile(mindmapFilePath, mindmapPageContent, 'utf8');
    console.log(`Successfully created combined mind map post at: ${mindmapFilePath}`);
}

/**
 * Main function to orchestrate the annotation process.
 */
async function main() {
    console.log("Starting bookmarks annotator script...");
    const bookmarksFilePath = await findLatestBookmarksFile();
    if (!bookmarksFilePath) return;

    const originalContent = await fs.readFile(bookmarksFilePath, 'utf8');
    const bookmarks = await parseBookmarksFile(bookmarksFilePath);
    if (bookmarks.length === 0) {
        console.log("Could not parse any valid bookmarks from the file. Exiting.");
        return;
    }

    let promptTextForApi = `${ANNOTATOR_PROMPT}\n--- START OF BOOKMARKS ---\n`;
    bookmarks.forEach(bookmark => {
        promptTextForApi += `\n[BOOKMARK]\nText: ${bookmark.text}\nURL: ${bookmark.linkUrl}\n`;
    });
    promptTextForApi += "\n--- END OF BOOKMARKS ---\n";

    try {
        console.log(`Sending ${bookmarks.length} bookmarks to Gemini for analysis and creation...`);
        const result = await model.generateContent(promptTextForApi);
        const fullResponse = result.response.text();

        // Updated parsing logic for two separators
        if (!fullResponse.includes(MINDMAP_LIBRARIAN_SEPARATOR) || !fullResponse.includes(MINDMAP_PHILOSOPHER_SEPARATOR)) {
            console.error("Gemini returned an invalid response missing one or both separators. Response was:", fullResponse);
            return;
        }

        const philosopherSplit = fullResponse.split(MINDMAP_PHILOSOPHER_SEPARATOR);
        const philosopherMapMarkdown = philosopherSplit[1];
        
        const librarianSplit = philosopherSplit[0].split(MINDMAP_LIBRARIAN_SEPARATOR);
        const ballad = librarianSplit[0];
        const librarianMapMarkdown = librarianSplit[1];
        
        if (!ballad || !librarianMapMarkdown || !philosopherMapMarkdown) {
             console.error("Failed to parse all three sections from the response.");
             return;
        }

        const originalFileName = path.basename(bookmarksFilePath, '.md');
        const mindmapPostFileName = `${originalFileName}-mindmap.md`;
        const mindmapPostFilePath = path.join(POSTS_DIR, mindmapPostFileName);

        const titleMatch = originalContent.match(/^title:\s*['"]?(.*?)['"]?$/m);
        const originalPostTitle = titleMatch ? titleMatch[1] : 'Bookmarks';

        // Pass both markdown strings to the creation function
        await createMindmapPost(librarianMapMarkdown, philosopherMapMarkdown, mindmapPostFilePath, originalPostTitle);

        const annotationBlock = `
<hr>

### A Ballad of the Bookmarks
${ballad.trim()}

${ANNOTATION_GUARD}
`;
        const newContent = originalContent + annotationBlock;
        await fs.writeFile(bookmarksFilePath, newContent);
        console.log(`Successfully annotated and created mind map for: ${path.basename(bookmarksFilePath)}`);

    } catch (error) {
        console.error("\n--- ERROR DURING GEMINI GENERATION ---", error);
    }
}

main();
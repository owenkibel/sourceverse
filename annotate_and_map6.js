// annotate_and_map_final.js

const fs = require('fs').promises;
const path = require('path');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const { ANNOTATOR_PROMPT } = require('./balladprompts/annotator_prompt1');

// --- Configuration ---
const POSTS_DIR = 'posts';
const MODEL_NAME = "gemini-2.5-flash";
const ANNOTATION_GUARD = "<!-- GEMINI-ANNOTATED -->";
const MINDMAP_LIBRARIAN_SEPARATOR = '---MINDMAP-SEPARATOR---';
const MINDMAP_PHILOSOPHER_SEPARATOR = '---PHILOSOPHER-SEPARATOR---';

const TOPICS = new Map([
    ['About', 'About ℹ️🏷️⭐'],
    ['Earth', 'Earth 🌏🌍🌎'],
    ['Make', 'Make ⚙️🍲🌻'],
    ['Reflection', 'Reflection 🌍⛅⛈️🌾🐘'],
    ['Humor', 'Humor 😂🤣😹'],
    ['Idea', 'Idea 💭💡🔥']
]);

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

function indentMarkdown(text, indent = '  ') {
    if (!text) return '';
    return text.trim().split('\n').map(line => indent + line).join('\n');
}

/**
 * [MODIFIED] This function now truncates the bookmark text to prevent oversized prompts.
 * This is the primary fix for the ENAMETOOLONG error.
 */
async function parseBookmarksFile(filePath) {
    const fileContent = await fs.readFile(filePath, 'utf8');
    const bookmarks = [];
    const rowRegex = /^\|.*\|$/gm;
    const innerLinkRegex = /(?<!\!)\[(.*?)\]\((.*?)\)/g;
    const MAX_TEXT_LENGTH = 500; // Define a reasonable character limit

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
            
            // [THE FIX] Truncate the text if it's too long before adding it to the list.
            if (fullText.length > MAX_TEXT_LENGTH) {
                fullText = fullText.slice(0, MAX_TEXT_LENGTH) + '...';
            }
            
            bookmarks.push({ text: fullText, linkUrl: linkUrl });
        }
    }
    console.log(`Parsed and truncated ${bookmarks.length} bookmarks.`);
    return bookmarks;
}

function parsePhilosopherMap(philosopherMarkdown) {
    const classifiedBookmarks = new Map();
    let currentCategory = null;
    for (const key of TOPICS.keys()) {
        classifiedBookmarks.set(key, []);
    }
    const lines = philosopherMarkdown.trim().split('\n');
    const linkRegex = /\[(.*?)\]\((.*?)\)/;

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;

        const categoryMatch = trimmedLine.match(/^[-\*] \**([A-Za-z]+)\**$/);
        if (categoryMatch) {
            const potentialCategory = categoryMatch[1];
            const normalizedCategory = [...TOPICS.keys()].find(k => k.toLowerCase() === potentialCategory.toLowerCase());
            if (normalizedCategory) {
                currentCategory = normalizedCategory;
                continue;
            }
        }

        if (currentCategory && linkRegex.test(trimmedLine)) {
            const cleanLine = trimmedLine.startsWith('- ') ? trimmedLine : `- ${trimmedLine.replace(/^[\*\+] /, '')}`;
            classifiedBookmarks.get(currentCategory).push(cleanLine);
        }
    }
    console.log("Philosopher map parsing complete. Classified links per category:");
    for (const [category, links] of classifiedBookmarks.entries()) {
        console.log(`  - ${category}: ${links.length} links found.`);
    }
    return classifiedBookmarks;
}

/**
 * [MODIFIED] Creates markdown files, including a unique timestamp in the filename and title.
 */
async function createTopicPosts(classifiedBookmarks, day, timestamp) {
    const writePromises = [];
    for (const [category, links] of classifiedBookmarks.entries()) {
        if (links.length === 0) continue;

        const subject = TOPICS.get(category);
        const mdFile = path.join(POSTS_DIR, `${day}-${timestamp}-${category.toLowerCase()}.md`);
        const linksMarkdown = links.join('\n');

        const postContent = `---
title: ${day}-${timestamp}-${subject}
author: Owen Kibel
tags:
  - ${category}
---

### ${subject}

<!-- These links are classified provocations for writing -->
${linksMarkdown}
`;
        writePromises.push(fs.writeFile(mdFile, postContent, 'utf8'));
        console.log(`Queueing creation of topic post: ${mdFile}`);
    }
    await Promise.all(writePromises);
    if (writePromises.length > 0) {
        console.log(`Successfully created ${writePromises.length} new topic posts.`);
    } else {
        console.log("No topic posts were created as no categories contained links.");
    }
}

async function createMindmapPost(librarianMarkdown, philosopherMarkdown, mindmapFilePath, originalPostTitle) {
    const combinedMindmapMarkdown = `# Combined Mind Map for ${originalPostTitle}\n\n- **Librarian's Thematic Map**\n${indentMarkdown(librarianMarkdown)}\n\n- **Philosopher's Sorting Map**\n${indentMarkdown(philosopherMarkdown)}`.trim();
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
    // Pass the mindmapFilePath directly to fs.writeFile
    await fs.writeFile(mindmapFilePath, mindmapPageContent, 'utf8');
    console.log(`Successfully created combined mind map post at: ${mindmapFilePath}`);
}

async function main() {
    console.log("Starting full annotation and topic post creation script...");
    const bookmarksFilePath = await findLatestBookmarksFile();
    if (!bookmarksFilePath) return;

    const originalContent = await fs.readFile(bookmarksFilePath, 'utf8');
    const bookmarks = await parseBookmarksFile(bookmarksFilePath);
    if (bookmarks.length === 0) {
        console.log("Could not parse any valid bookmarks. Exiting.");
        return;
    }

    let promptTextForApi = `${ANNOTATOR_PROMPT}\n--- START OF BOOKMARKS ---\n`;
    bookmarks.forEach(bookmark => {
        promptTextForApi += `\n[BOOKMARK]\nText: ${bookmark.text}\nURL: ${bookmark.linkUrl}\n`;
    });
    promptTextForApi += "\n--- END OF BOOKMARKS ---\n";

    try {
        console.log(`Sending ${bookmarks.length} bookmarks to Gemini for analysis...`);
        const result = await model.generateContent(promptTextForApi);
        const fullResponse = result.response.text();

        if (!fullResponse.includes(MINDMAP_LIBRARIAN_SEPARATOR) || !fullResponse.includes(MINDMAP_PHILOSOPHER_SEPARATOR)) {
            console.error("Gemini response was invalid (missing separators). Response:", fullResponse);
            return;
        }
        const philosopherSplit = fullResponse.split(MINDMAP_PHILOSOPHER_SEPARATOR);
        const philosopherMapMarkdown = philosopherSplit[1];
        const librarianSplit = philosopherSplit[0].split(MINDMAP_LIBRARIAN_SEPARATOR);
        const ballad = librarianSplit[0];
        const librarianMapMarkdown = librarianSplit[1];
        if (!ballad || !librarianMapMarkdown || !philosopherMapMarkdown) {
             console.error("Failed to parse all three sections from the AI response.");
             return;
        }

        const originalFileName = path.basename(bookmarksFilePath, '.md');
        const mindmapPostFileName = `${originalFileName}-mindmap.md`;
        const mindmapPostFilePath = path.join(POSTS_DIR, mindmapPostFileName);
        const titleMatch = originalContent.match(/^title:\s*['"]?(.*?)['"]?$/m);
        const originalPostTitle = titleMatch ? titleMatch[1] : 'Bookmarks';
        
        await createMindmapPost(librarianMapMarkdown, philosopherMapMarkdown, mindmapPostFilePath, originalPostTitle);
        
        const annotationBlock = `\n<hr>\n\n### A Ballad of the Bookmarks\n${ballad.trim()}\n\n${ANNOTATION_GUARD}\n`;
        await fs.writeFile(bookmarksFilePath, originalContent + annotationBlock);
        console.log(`Successfully annotated and created mind map for: ${path.basename(bookmarksFilePath)}`);

        // --- TIMESTAMP LOGIC ---
        const now = new Date();
        const dayString = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${now.getFullYear()}`;
        const timestamp = now.toISOString(); // Generate a unique timestamp for this run
        
        const classifiedBookmarks = parsePhilosopherMap(philosopherMapMarkdown);
        await createTopicPosts(classifiedBookmarks, dayString, timestamp);

        console.log("All tasks completed successfully.");

    } catch (error) {
        console.error("\n--- ERROR DURING SCRIPT EXECUTION ---", error);
    }
}

async function findLatestBookmarksFile() {
    /* ... function content is unchanged ... */
    try {
        const files = await fs.readdir(POSTS_DIR);
        const bookmarkFiles = files.filter(file => file.startsWith('bookmarks-') && file.endsWith('.md')).sort().reverse();
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

main();
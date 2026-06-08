const fs = require('fs').promises;
const ogs = require('open-graph-scraper');

// Configurable constants for ceiling calculation
const numerator = 6000;   // Total bookmarks to consider in reset case
const denominator = 2;   // Number of posts to split into (ceiling = 15 with defaults)
const ceiling = Math.floor(numerator / denominator); // 15 with defaults

// Logic for existing file updates
const BASE_CHUNK_SIZE = 50;
const MIN_REMAINDER = 10; // If remaining bookmarks are <= this, merge them into previous chunk

const lastTimestampFile = 'last-bookmark-timestamp.txt';
const chromeEpochOffset = 11644473600000000;

function escapeMd(text) {
  if (!text) return '';
  return text.replace(/([\\_*[\]#`~|<>])/g, '\\$1');
}

(async () => {
  try {
    // Check if timestamp file exists
    let lastTimestamp = 0;
    let fileExists = true;
    try {
      const timestampData = await fs.readFile(lastTimestampFile, 'utf8');
      lastTimestamp = parseInt(timestampData.trim()) || 0;
    } catch (error) {
      console.log('No previous timestamp file found, initializing reset mode');
      fileExists = false;
    }

    // Read and parse bookmarks file
    const data = await fs.readFile('/home/owen/.config/google-chrome-unstable/Default/Bookmarks', 'utf8');
    let bookmarks = JSON.parse(data);
    const roots = bookmarks.roots.other.children;

    // Filter and sort bookmarks
    let newBookmarks = roots
      .filter(b => b && b.url && b.date_added)
      .map(b => ({
        url: b.url,
        name: b.name,
        date_added: parseInt(b.date_added)
      }))
      .sort((a, b) => b.date_added - a.date_added); // Newest first

    if (fileExists) {
      // Existing file: Process new bookmarks since last timestamp
      newBookmarks = newBookmarks
        .filter(b => b.date_added > lastTimestamp);

      // Sort the new bookmarks oldest first for batch processing
      newBookmarks.sort((a, b) => a.date_added - b.date_added);

      if (newBookmarks.length === 0) {
        console.log('No new bookmarks since last run');
      } else {
        console.log(`Found ${newBookmarks.length} new bookmarks.`);
        
        let processedCount = 0;
        
        // Dynamic Chunking Loop
        while (processedCount < newBookmarks.length) {
          let currentChunkSize = BASE_CHUNK_SIZE;
          const remainingItems = newBookmarks.length - (processedCount + BASE_CHUNK_SIZE);

          // Check if the remainder would be too small (<= 10)
          if (remainingItems > 0 && remainingItems <= MIN_REMAINDER) {
            currentChunkSize += remainingItems;
            console.log(`Adjusting chunk size to ${currentChunkSize} to avoid a remainder of ${remainingItems}.`);
          } else if (remainingItems < 0) {
            // We are at the end and total is less than base chunk
            currentChunkSize = newBookmarks.length - processedCount;
          }

          const chunk = newBookmarks.slice(processedCount, processedCount + currentChunkSize);
          
          // Process this chunk
          const oldestDateAdded = chunk[0].date_added;
          const chunkDate = new Date((oldestDateAdded - chromeEpochOffset) / 1000);
          
          await processBookmarks(chunk, chunkDate);
          
          // Update timestamp file immediately after successful chunk
          const newestInChunk = chunk[chunk.length - 1].date_added;
          await fs.writeFile(lastTimestampFile, newestInChunk.toString());
          
          processedCount += chunk.length;
          console.log(`Batch complete. Processed ${processedCount}/${newBookmarks.length} bookmarks. Timestamp updated to ${newestInChunk}`);
        }
      }
    } else {
      // No file (reset): Take latest numerator bookmarks, split into denominator posts
      newBookmarks = newBookmarks.slice(0, numerator);
      if (newBookmarks.length === 0) {
        console.log('No bookmarks available to process');
        return;
      }

      // Split into chunks of ceiling size
      const bookmarkChunks = [];
      for (let i = 0; i < newBookmarks.length; i += ceiling) {
        bookmarkChunks.push(newBookmarks.slice(i, i + ceiling));
      }

      // Process each chunk with its oldest bookmark's timestamp
      for (const chunk of bookmarkChunks) {
        const oldestDateAdded = Math.min(...chunk.map(b => b.date_added));
        const chunkDate = new Date((oldestDateAdded - 11644473600000000) / 1000);
        await processBookmarks(chunk, chunkDate);
      }

      // Initialize timestamp file with the newest bookmark
      const newestTimestamp = Math.max(...newBookmarks.map(b => b.date_added));
      await fs.writeFile(lastTimestampFile, newestTimestamp.toString());
      console.log(`Initialized ${bookmarkChunks.length} posts with ${newBookmarks.length} total bookmarks, set timestamp to ${newestTimestamp}`);
    }

  } catch (error) {
    console.error('Error:', error.message);
  }
})();

// Helper function to process bookmarks into a markdown file
async function processBookmarks(bookmarks, dateObj) {
  // Use full ISO string from date_added for unique filename
  const timestamp = dateObj.toISOString(); 
  const mdFile = `posts/bookmarks-${timestamp}.md`;

  let header = `---
title: Bookmarks ${timestamp}
author: Owen Kibel
tags:
  - Bookmarks
---
# Bookmarks for ${timestamp}

`;

  // IMPROVEMENT: Process OGS in parallel for speed, maintaining order via Promise.all
  const bookmarkPromises = bookmarks.map(async (bookmark) => {
    const dateMs = (bookmark.date_added - chromeEpochOffset) / 1000;
    const readableDate = new Date(dateMs).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    let favicon = '', ogImage = '', ogTitle = '', ogSiteName = '', ogDescription = '', articleBody = '';
    
    try {
      const { result } = await ogs({ url: bookmark.url });
      favicon = result.favicon || '';
      ogImage = result.ogImage && result.ogImage.length > 0 ? result.ogImage[0].url : '';
      ogTitle = result.ogTitle || '';
      ogSiteName = result.ogSiteName || '';
      ogDescription = result.ogDescription || '';
      if (result.jsonLD && Array.isArray(result.jsonLD)) {
        const article = result.jsonLD.find(item => item.articleBody);
        if (article) articleBody = article.articleBody;
      }
    } catch (ogError) {
      console.error(`Error scraping ${bookmark.url}: ${ogError.message}`);
    }

    // Build list item string
    let itemContent = '- ';
    if (favicon) {
      itemContent += `![Favicon](${favicon}) `;
    }
    itemContent += `[${escapeMd(bookmark.name)}](${bookmark.url})\n`;
    const indent = '  ';
    itemContent += `${indent}Added: ${readableDate}\n\n`;
    if (ogTitle) {
      itemContent += `${indent}**${escapeMd(ogTitle)}**\n\n`;
    }
    if (ogSiteName) {
      itemContent += `${indent}Site: ${escapeMd(ogSiteName)}\n\n`;
    }
    if (ogDescription) {
      itemContent += `${indent}${escapeMd(ogDescription).replace(/\n/g, `\n${indent}`)}\n\n`;
    }
    if (articleBody) {
      const quoted = escapeMd(articleBody).replace(/\n/g, `\n${indent}> `);
      itemContent += `${indent}> ${quoted}\n\n`;
    }
    if (ogImage) {
      itemContent += `${indent}![${escapeMd(bookmark.name)}](${ogImage})\n\n`;
    }
    
    return itemContent;
  });

  const processedBookmarks = await Promise.all(bookmarkPromises);
  const content = header + processedBookmarks.join('');

  await fs.writeFile(mdFile, content);
  console.log(`Wrote ${bookmarks.length} bookmarks to ${mdFile}`);
}
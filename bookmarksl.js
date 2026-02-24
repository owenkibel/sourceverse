const fs = require('fs').promises;
const ogs = require('open-graph-scraper');

// Configurable constants for ceiling calculation
const numerator = 300;   // Total bookmarks to consider in reset case
const denominator = 2;   // Number of posts to split into (ceiling = 15 with defaults)
const ceiling = Math.floor(numerator / denominator); // 15 with defaults

const lastTimestampFile = 'last-bookmark-timestamp.txt';

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
    const data = await fs.readFile('/path/to', 'utf8');
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
      // Existing file: Process new bookmarks since last timestamp, up to ceiling
      newBookmarks = newBookmarks
        .filter(b => b.date_added > lastTimestamp)
        .slice(0, ceiling);

      if (newBookmarks.length > 0) {
        await processBookmarks(newBookmarks, new Date());
        const newestTimestamp = Math.max(...newBookmarks.map(b => b.date_added));
        await fs.writeFile(lastTimestampFile, newestTimestamp.toString());
        console.log(`Processed ${newBookmarks.length} new bookmarks, updated timestamp to ${newestTimestamp}`);
      } else {
        console.log('No new bookmarks since last run');
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
  const timestamp = dateObj.toISOString(); // e.g., "2025-03-07T12:34:56.789Z"
  const mdFile = `posts/bookmarks-${timestamp}.md`;

  // Simplified table header
  let content = `---
title: Bookmarks ${timestamp}
author: Author
tags:
  - Bookmarks
---
### ${bookmarks.length} New Bookmarks

| Favicon | Details |
|---------|---------|
`;

  // Process each bookmark
  for (const bookmark of bookmarks) {
    const chromeEpochOffset = 11644473600000000;
    const dateMs = (bookmark.date_added - chromeEpochOffset) / 1000;
    const readableDate = new Date(dateMs).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    let favicon = '', details = '', ogImage = '';
    try {
      const { result } = await ogs({ url: bookmark.url });
      favicon = result.favicon ? `![Favicon](${result.favicon})` : '';
      ogImage = result.ogImage && result.ogImage.length > 0 ? result.ogImage[0].url : '';
      
      // Compact details column
      details = `[${bookmark.name}](${bookmark.url})<br>${readableDate}`;
      if (result.ogTitle) details += `<br>**${result.ogTitle}**`;
      if (result.ogSiteName) details += `<br>${result.ogSiteName}`;
      if (result.ogDescription) details += `<br>${result.ogDescription}`;
      if (result.jsonLD && Array.isArray(result.jsonLD)) {
        const article = result.jsonLD.find(item => item.articleBody);
        if (article) details += `<br><blockquote>${article.articleBody}</blockquote>`;
      }

    } catch (ogError) {
      console.error(`Error scraping ${bookmark.url}: ${ogError.message}`);
      details = `[${bookmark.name}](${bookmark.url})<br>${readableDate}`;
    }

    // Table row followed by full-size image
    content += `| ${favicon} | ${details} |\n`;
    if (ogImage) content += `![${bookmark.name}](${ogImage})\n\n`;
    else content += `\n`;
  }

  await fs.writeFile(mdFile, content);
  console.log(`Wrote ${bookmarks.length} bookmarks to ${mdFile}`);
}

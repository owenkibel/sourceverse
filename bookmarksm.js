const fs = require('fs').promises;
const path = require('path');

const now = new Date();
const day = now.toISOString();
const bookmarksFile = '/path/to';
const dateAddedFile = 'last-date-added.txt';
const mdFile = `posts/music-${day}.md`;

(async () => {
  try {
    // Read the last saved date_added value (default to 0 if file doesn't exist)
    let lastDateAdded = 0;
    try {
      const dateData = await fs.readFile(dateAddedFile, 'utf8');
      lastDateAdded = parseInt(dateData.trim()) || 0;
    } catch (error) {
      console.log('No previous date_added file found, starting fresh');
    }

    // Read and parse bookmarks file
    const data = await fs.readFile(bookmarksFile, 'utf8');
    let bookmarks = JSON.parse(data);

    const roots = bookmarks.roots.other.children;
    
    // Get YouTube Music bookmarks with date_added, filter by date, and remove duplicates
    const musicYouTubeBookmarks = roots
      .filter(b => b && b.url && b.url.startsWith('https://music.youtube.com/') && b.date_added)
      .map(b => ({
        url: b.url,
        name: b.name,
        date_added: parseInt(b.date_added)
      }))
      .sort((a, b) => b.date_added - a.date_added) // Sort by date_added descending
      .filter((bookmark, index, self) => 
        bookmark.date_added > lastDateAdded && // Only newer bookmarks
        self.findIndex(t => t.url === bookmark.url) === index // Remove duplicates
      )
      .slice(0, 24); // Take most recent 24

    // If we have new bookmarks, write the files
    if (musicYouTubeBookmarks.length > 0) {
      // Create markdown header
      await fs.writeFile(mdFile, `---
title: Youtube Music ${day}
author: Author
tags:
  - Music
---
### Latest ${musicYouTubeBookmarks.length} Youtube Music bookmarks - most recent on top

`);

      // Format and append bookmark links
      const bookmarkText = musicYouTubeBookmarks
        .map(bookmark => `[${bookmark.name}](${bookmark.url})\n`)
        .join('');
      await fs.appendFile(mdFile, bookmarkText);

      // Update the last date_added file with the most recent date
      const newestDateAdded = Math.max(...musicYouTubeBookmarks.map(b => b.date_added));
      await fs.writeFile(dateAddedFile, newestDateAdded.toString());

      console.log(`md file written successfully with ${musicYouTubeBookmarks.length} new bookmarks`);
      console.log(`Updated last date_added to ${newestDateAdded}`);
    } else {
      console.log('No new YouTube Music bookmarks found since last run');
    }

  } catch (error) {
    console.error('Error:', error.message);
  }
})();
// --- START OF MODIFIED url.js ---

import { createRequire } from "module";
const require = createRequire(import.meta.url);

import { getVideoDetails } from "youtube-caption-extractor";
import fs from 'fs';
const ogs = require('open-graph-scraper');
const htmlToText = require('html-to-text');
const sanitizeHtml = require('sanitize-html');
const cheerio = require('cheerio'); // <--- Import cheerio
const path = require('path');
import { URL } from 'url'; // <--- Import URL for resolving relative image paths

const directory = '/home/owen/Downloads/jsonlet';
// Create output directory if it doesn't exist
const outputDirectory = 'ogs_data';
if (!fs.existsSync(outputDirectory)){
    fs.mkdirSync(outputDirectory);
}

const files = fs.readdirSync(directory);
// Define the regex to extract the 11 character video ID
const regex = /(?:v=|shorts\/|live\/)([a-zA-Z0-9_-]{11})/;
let arr = [];

console.log(`Reading JSON files from: ${directory}`);
for (const file of files) {
    const filePath = path.join(directory, file);
    if (path.extname(filePath) === '.json') {
        try {
            const inputJSON = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            let newInputJSON = {};

            // Ensure inputJSON has a url property before matching
            if (!inputJSON || typeof inputJSON.url !== 'string') {
                console.warn(`Skipping ${file}: Missing or invalid 'url' property.`);
                continue;
            }

            console.log(`Processing: ${file} for URL: ${inputJSON.url}`);
            const match = inputJSON.url.match(regex);
            if (match) {
              const videoId = match[1];
              newInputJSON = {
                ...inputJSON,
                videoid: videoId
              };
            } else {
              newInputJSON = {
                ...inputJSON,
                videoid: null // Explicitly set to null if no match
              };
            }
            arr.push(newInputJSON);

        } catch (error) {
            console.error(`Error processing ${filePath}:`, error);
        }
    }
}

// Output the intermediate array with video IDs (optional, for debugging)
// fs.writeFileSync('urls_with_ids.json', JSON.stringify(arr, null, 2));
console.log(`Processed ${arr.length} items with video IDs.`);

// Global object to store scraped data - Consider if this is necessary or if data should be scoped per item
// For simplicity and matching the original structure, we keep it global for now.
const scrapedData = {};

// Function to fetch and save YouTube video captions
const fetchAndSaveCaptions = async (item) => {
  if (!item || !item.videoid) {
      // No video ID, nothing to fetch
      return;
  }
  try {
    const videoDetails = await getVideoDetails({ videoID: item.videoid });
    const subtitlesText = videoDetails.subtitles?.map(obj => obj.text).join(' ') || ''; // Handle case with no subtitles

    // Ensure the base object for the URL exists
    if (!scrapedData[item.url]) {
        scrapedData[item.url] = {};
    }

    scrapedData[item.url] = {
      ...scrapedData[item.url],
      youtube: {
        title: videoDetails.title || '',
        description: videoDetails.description || '',
        subtitles: subtitlesText,
        length: subtitlesText.length
      }
    };
    console.log(`Fetched YouTube data for ${item.name || item.url}`);
  } catch (error) {
    console.error(`Error fetching captions for ${item.name || item.url} (ID: ${item.videoid}):`, error.message);
     // Add error info to the item's data
     if (!scrapedData[item.url]) {
        scrapedData[item.url] = {};
     }
     scrapedData[item.url].youtubeError = `Failed to fetch captions: ${error.message}`;
  }
};


// Function to scrape Open Graph data and extract images
const scrapeOpenGraph = async (item) => {
  if (!item || !item.url) {
      console.warn(`Skipping Open Graph scrape: Missing item or URL.`);
      return;
  }
  try {
    const options = { url: item.url };
    // Use result, html, error naming convention from ogs, rename error to avoid scope collision
    const { result, html: rawHtml, error: ogsError } = await ogs(options);

    // Ensure the base object for the URL exists even if OGS fails
    if (!scrapedData[item.url]) {
        scrapedData[item.url] = {};
    }

    if (ogsError || !result.success) {
      scrapedData[item.url] = {
        ...scrapedData[item.url],
        error: 'Open Graph scraping failed',
        ogErrorDetails: ogsError ? ogsError.toString() : 'Result success false'
      };
      console.error(`Error scraping Open Graph data for ${item.url}:`, ogsError || 'Result success false');
      return; // Stop processing this item's OG/HTML if scraping failed
    }

    // --- Start New Image Extraction Logic ---
    let imageSources = [];
    if (rawHtml) { // Proceed only if HTML was fetched
      try {
        const $ = cheerio.load(rawHtml);
        // Select images within the body tag. You could refine this selector further (e.g., 'main img', 'article img') if needed.
        $('body img').each((index, element) => {
          const src = $(element).attr('src');
          
          if (src) {
            try {
                // Resolve relative URLs to absolute URLs using the page's URL as the base
                const absoluteUrl = new URL(src, item.url).href;
                 imageSources.push(absoluteUrl);
            } catch (urlError) {
                // Handle cases where src is invalid or base URL is problematic
                console.warn(`Could not resolve image URL "${src}" relative to ${item.url}: ${urlError.message}. Storing original src.`);
                // Push the original src if resolution fails but src exists
                imageSources.push(src);
            }
          }
        });
        console.log(`Extracted ${imageSources.length} images from ${item.url}`);
      } catch (parseError) {
          console.error(`Error parsing HTML with Cheerio for images for ${item.url}:`, parseError);
          scrapedData[item.url].imageExtractionError = `Cheerio parsing failed: ${parseError.message}`;
      }
    } else {
         console.warn(`No HTML content returned by OGS for ${item.url}. Skipping image extraction.`);
         scrapedData[item.url].imageExtractionError = 'No HTML content returned by OGS.';
    }
    // --- End New Image Extraction Logic ---

    // Sanitize and extract text (using the same rawHtml)
    // Allow 'main' tag content, fall back to empty string if no rawHtml
    const sanitizedHtml = sanitizeHtml(rawHtml || '', {
        allowedTags: ['main'] // Focus text extraction on <main> content
    });
    const mainText = htmlToText.convert(sanitizedHtml, {
        wordwrap: false // Optional: prevent line wrapping in extracted text
    });

    // Update scrapedData for this URL
    scrapedData[item.url] = {
      ...scrapedData[item.url], // Keep existing data (youtube, name, url, potentially errors)
      ogResult: result,         // The Open Graph result object
      ogHTML: mainText,         // Text content primarily from <main>
      ogLength: mainText.length,// Length of the extracted text
      images: imageSources      // <--- Add the new array of image objects
    };

  } catch (error) { // Catch general errors in the function (e.g., network issues before ogs call)
     // Ensure the base object exists before adding error info
     if (!scrapedData[item.url]) {
        scrapedData[item.url] = {};
     }
    scrapedData[item.url].error = `Scraping failed: ${error.message}`;
    console.error(`Generic error in scrapeOpenGraph for ${item.url}:`, error);
  }
};


// Function to add name and url to the global object
const addNameAndUrl = (item) => {
  if (!item || !item.url) return; // Basic validation
  // Use the spread operator to ensure previous data (like errors added earlier) is retained
  // Initialize object if it doesn't exist for this URL yet.
  scrapedData[item.url] = {
    ...scrapedData[item.url], // Keep any pre-existing data for this URL
    name: item.name,
    url: item.url,
  };
};


// --- Main Execution Logic ---
async function processItems() {
    console.log(`Starting processing for ${arr.length} items...`);
    // Iterate through each item in the processed array `arr`
    for (const item of arr) {
      try {
        console.log(`\nProcessing item: ${item.name || item.url}`);

        // Add name and URL to the item's entry in scrapedData
        // Do this first so the entry exists even if subsequent steps fail
        addNameAndUrl(item);

        // Fetch and save captions (if it's a YouTube video)
        await fetchAndSaveCaptions(item);

        // Scrape Open Graph data and images for the item
        await scrapeOpenGraph(item);

        // Prepare filename based on the name or URL (ensure it's safe)
        const baseFilename = (item.name || item.url)
            .replace(/[^A-Za-z0-9._-]/g, '') // Replace unsafe characters with underscore
            .substring(0, 50); // Limit length to avoid overly long filenames
        const filename = baseFilename + '.json';
        const outputFilePath = path.join(outputDirectory, filename);

        // Write the combined scraped data for this item to its JSON file
        if (scrapedData[item.url] && Object.keys(scrapedData[item.url]).length > 2) { // Check if we have more than just name/url
             fs.writeFileSync(outputFilePath, JSON.stringify(scrapedData[item.url], null, 2));
             console.log(`Data saved to ${outputFilePath}`);
        } else {
             console.log(`Skipping file write for ${item.url} as no substantial data was scraped.`);
        }


      } catch (error) {
        // Handle any unexpected errors during the processing loop for an item
        console.error(`Critical error processing item: ${item.url || JSON.stringify(item)} - ${error.message}`, error.stack);
         // Optionally add error to the specific item if possible
         if(item && item.url && scrapedData[item.url]) {
             scrapedData[item.url].criticalError = `Loop processing error: ${error.message}`;
         }
      }
    }
    console.log('\nProcessing complete.');
}

// Run the main processing function
processItems();

// --- END OF MODIFIED url.js ---
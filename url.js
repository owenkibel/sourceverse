import { createRequire } from "module";
const require = createRequire(import.meta.url);

import { getVideoDetails } from "youtube-caption-extractor";
import fs from 'fs';
const ogs = require('open-graph-scraper');
const htmlToText = require('html-to-text');
const sanitizeHtml = require('sanitize-html');

const path = require('path');

const directory = '/home/owen/Downloads/jsonlet'; 
const files = fs.readdirSync(directory);
// Define the regex to extract the 11 character video ID
const regex = /(?:v=|shorts\/|live\/)([a-zA-Z0-9_-]{11})/;
let arr = [];

for (const file of files) {
    const filePath = path.join(directory, file); 
    if (path.extname(filePath) === '.json') { 
        try {
            const inputJSON = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            let newInputJSON = {};

            // ... your Ollama request logic ...

            console.log(file)
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
                videoid: null
              };
            }
            arr.push(newInputJSON);           

// Output the modified JSON to a file (optional)
fs.writeFileSync('urls1.json', JSON.stringify(arr, null, 2));            
        } catch (error) {
            console.error(`Error processing ${filePath}:`, error);
        }
    }
}

// Global object to store scraped data
const scrapedData = {};

// Function to fetch and save YouTube video captions
const fetchAndSaveCaptions = async (item) => {
  try {
    if (item.videoid) {
      const videoDetails = await getVideoDetails({ videoID: item.videoid });
      scrapedData[item.url] = {
        ...scrapedData[item.url],
        youtube: {
          title: videoDetails.title,
          description: videoDetails.description,
          subtitles: videoDetails.subtitles.map(obj => obj.text).join(' '),
          length: videoDetails.subtitles.map(obj => obj.text).join(' ').length
        }
      };
    }
  } catch (error) {
    console.error(`Error fetching captions for ${item.name}:`, error);
  }
};



// Function to scrape Open Graph data
const scrapeOpenGraph = async (item) => {
  try {
    const options = { url: item.url };
    const { result, html, error } = await ogs(options);
    if (error) {
      scrapedData[item.url] = { 
        error: 'Open Graph scraping failed' 
      };
      console.error(`Error scraping Open Graph data for ${item.url}:`, error);
      return; // Stop processing this item if scraping failed
    }
    scrapedData[item.url] = {
      ...scrapedData[item.url],
      ogResult: result, 
      ogHTML: htmlToText.convert(sanitizeHtml(html, {
        allowedTags: ['main']
      })),
      ogLength: htmlToText.convert(sanitizeHtml(html, {
        allowedTags: ['main']
      })).length
    };
  } catch (error) {
    scrapedData[item.url] = {
      ...scrapedData[item.url], 
      error: error
    };
    console.error(`Error scraping Open Graph data for ${item.url}:`, error);
  }
};

  
// Function to add name and url to the global object
const addNameAndUrl = (item) => {
  // Use the spread operator to ensure previous data is retained
  scrapedData[item.url] = {
    ...scrapedData[item.url],
    name: item.name,
    url: item.url,
  };
};


// Read input.json
// const inputJSON = JSON.parse(fs.readFileSync('urls.json', 'utf8')); 

// Iterate through each item in the input JSON
for (const item of arr) {
  try {

    // Add name and URL to the item
    addNameAndUrl(item);

    // Fetch and save captions for the item
    await fetchAndSaveCaptions(item);

    // Scrape Open Graph data for the item
    await scrapeOpenGraph(item);

    // Prepare filename based on the URL
  
    const filename = item.name.replace(/[^A-Za-z0-9]/g, '').substring(0, 15) + '.json';

  // Write scraped data to a JSON file with indentation of 2 spaces
    fs.writeFileSync(`ogs_data/${filename}`, JSON.stringify(scrapedData[item.url], null, 2));

    // Log the filename where data was saved
    console.log(`Data saved to ${filename}`);
  } catch (error) {
    // Handle any errors that occurred during processing
    console.error(`Error processing item: ${item.url} - ${error.message}`);
  }
}

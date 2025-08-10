const fs = require('fs');
const yaml = require('js-yaml');

// Configuration
const dataFilePath = '/home/owen/cachyos2/owen/sourceverse/theme-simple-blog/src/_data.yml';
const indexFilePath = './dataIndex.txt';
const welcomeMessages = [
    "From Video and Punditry to AI-Grown Poetry",
    "GenAI Poetry from Video and Punditry",
    "Verses from Sources",
    "Web seeded, AI grown Poetry",
    "Poetic AI-Evolution",
    "Generative AIEvolution",
    "Theory of AIEvolution",
    "AI Evolved Verses from Web Sources",
    "From columns of thought, to verse in the making",
    "Of Clouds and Columns",
    "GenAI echoes of Articles and Columns",
    "Seeding imagination's fertile ground",
    "From Columns to Golems",
    "Evolve a Verse",
    "AI evolved Verses from far-flung Sources",
    "Echoic Articles",
    "Poetic AIlchemy",
    "Chimeric Chronicles",
    "Terrestrial Intelligence",
    "Poetry from Punditry",
    "Creative AImagination",
    "Various Verses from Diverse Sources",
    "A Groetry for Poetry",
    "Poetic AImagination",
    "Open Source Verse",
    "From Columns to Gollums",
    "Versifying the News",
    "An Ode to Code",
    "genAI-fertilized Articles",
    "A type of Poem thats a Groem",
    "Groem to Poem",
    "AInoculate the News",
    "Fertilized Opinion",
    "Fertilize the News",
    "Poetic Fertizer",
    "Poetic Punditry"
];

// Helper function to read a file and return its content
const readFile = (filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    console.error(`Error reading file ${filePath}:`, error.message);
    return null;
  }
};

// Helper function to write content to a file
const writeFile = (filePath, data) => {
  try {
    fs.writeFileSync(filePath, data, 'utf8');
    console.log(`Successfully wrote to file: ${filePath}`);
    return true;
  } catch (error) {
    console.error(`Error writing file ${filePath}:`, error.message);
    return false;
  }
};

// Load the current index from the index file
let currentIndex = 0;
const indexContent = readFile(indexFilePath);

if (indexContent) {
  currentIndex = parseInt(indexContent, 10);
  if (isNaN(currentIndex)) {
    console.warn("Invalid index in index file. Resetting to 0.");
    currentIndex = 0;
  }
}

// Get the new welcome message
const newWelcomeMessage = welcomeMessages[currentIndex];

// Read data from _data.yml
const dataYmlContent = readFile(dataFilePath);

if (dataYmlContent) {
  try {
    // Load the data from the file
    const data = yaml.load(dataYmlContent);

    // Update the data
    data.home.welcome = newWelcomeMessage;

    // Convert the YML object to string
    const newContent = yaml.dump(data);

    // Write the new file
    writeFile(dataFilePath, newContent)

    // Advance the index for the next time the file is used
    const nextIndex = (currentIndex + 1) % welcomeMessages.length;
    writeFile(indexFilePath, nextIndex.toString());

    //Print out success
    console.log(`Changed welcome message to ${newWelcomeMessage}, and updated the index for the next execution`);
  } catch (error) {
    console.error('Error parsing YAML or writing file:', error.message);
  }
} else {
    console.log("There was an error, so now exiting.");
}
const fs = require('fs');
const path = require('path');

// --- Configuration ---
// Updated source directory to ./images
const mp4Dir = './images'; 
const outputDir = './posts';

// --- Main Function ---
function generateVideoPost() {
  // Ensure output directories exist
  try {
    if (!fs.existsSync(mp4Dir)) {
      console.error(`Error: Source directory ${mp4Dir} does not exist.`);
      return; 
    }
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
  } catch (error) {
    console.error('Error creating directories:', error);
    return;
  }

  let files;
  try {
    files = fs.readdirSync(mp4Dir);
  } catch (error) {
    console.error(`Error reading the source directory: ${mp4Dir}`, error);
    return;
  }

  // Filter for MP4 files starting with 'gemini-video-veo3-'
  // Sorting chronologically works because the timestamp is a numerical string
  const mp4Files = files
    .filter(file => path.extname(file).toLowerCase() === '.mp4' && file.startsWith('gemini-video-veo3-'))
    .sort(); 

  if (mp4Files.length === 0) {
    console.log(`No MP4 files starting with 'gemini-video-veo3-' found in the ${mp4Dir} directory.`);
    return;
  }

  const currentDate = new Date().toLocaleString();

  const frontMatter = `---
title: Veo Videos - ${currentDate}
---
`;

  // Video player controls and display element
  const playerControls = `
<div style="margin-bottom: 10px;">
  <button id="toggle-order-btn" style="padding: 8px 12px; font-size: 14px; cursor: pointer;">Order: Chronological</button>
</div>
<video id="video-player" autoplay width="100%"></video>
<div id="now-playing" style="text-align: center; margin-top: 8px; font-family: monospace; min-height: 1.2em;"></div>
<hr>
`;

  // Create hidden video elements using the new URL path
  const videoSources = mp4Files.map(file => `<video src="/images/${file}" style="display:none;"></video>`).join('\n');

  // The client-side script remains the same, as the logic is generic.
  const script = `
<script>
  document.addEventListener('DOMContentLoaded', () => {
    const videoPlayer = document.getElementById('video-player');
    const orderButton = document.getElementById('toggle-order-btn');
    const nowPlayingElement = document.getElementById('now-playing');
    // The original, chronologically sorted playlist from the DOM
    const chronologicalPlaylist = Array.from(document.querySelectorAll('video[src]')).map(video => video.getAttribute('src'));
    let currentPlaylist = [...chronologicalPlaylist];
    let currentVideoIndex = 0;
    let orderState = 'chrono'; // 'chrono', 'reverse', 'random'
// Fisher-Yates (aka Knuth) Shuffle algorithm
    function shuffleArray(array) {
      let currentIndex = array.length, randomIndex;
      const shuffled = [...array];
      while (currentIndex !== 0) {
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;
        [shuffled[currentIndex], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[currentIndex]];
      }
      return shuffled;
    }
  function playNextVideo() {
      if (currentVideoIndex < currentPlaylist.length) {
        const currentSrc = currentPlaylist[currentVideoIndex];
        videoPlayer.src = currentSrc;
                // Extract filename from path and update the display element's text
        const filename = currentSrc.split('/').pop();
        nowPlayingElement.innerText = filename;
videoPlayer.load();
        videoPlayer.play().catch(e => console.error("Playback was interrupted or requires user interaction:", e));
        currentVideoIndex++;
      } else {
        // Loop the playlist
        currentVideoIndex = 0;
        playNextVideo();
      }
    }
    videoPlayer.addEventListener('ended', playNextVideo);
    orderButton.addEventListener('click', () => {
      if (orderState === 'chrono') {
        orderState = 'reverse';
        orderButton.textContent = 'Order: Reverse Chronological';
        currentPlaylist = [...chronologicalPlaylist].reverse();
      } else if (orderState === 'reverse') {
        orderState = 'random';
        orderButton.textContent = 'Order: Random';
        currentPlaylist = shuffleArray(chronologicalPlaylist);
      } else { // 'random'
        orderState = 'chrono';
        orderButton.textContent = 'Order: Chronological';
        currentPlaylist = [...chronologicalPlaylist];
      }
      // Restart playlist from the beginning with the new order
      currentVideoIndex = 0;
      playNextVideo();
    });
// Start the initial playlist
    if(currentPlaylist.length > 0) {
        playNextVideo();
    }
  });
</script>
`;

  const postContent = frontMatter + playerControls + videoSources + script;
  const outputFilePath = path.join(outputDir, `veo-video-playlist-${Date.now()}.md`);

  try {
    fs.writeFileSync(outputFilePath, postContent);
    console.log(`Successfully created post with ${mp4Files.length} videos: ${outputFilePath}`);
  } catch (error) {
    console.error('Error writing the final post file:', error);
  }
}

// --- Run the Script ---
generateVideoPost();
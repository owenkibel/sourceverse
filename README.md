## Sourceverse - Groetry

[Sourceverse](https://github.com/owenkibel/sourceverse.git)

[Groetry](https://groetry.vercel.app/)

Groetry is a reflective blog and conservatory of urls. Authorship is shared with ascribed AI models. The models examine web sources and interpret them as further AI prompts and poetry - and sometimes as generated images.

Sourceverse is the Open Source base of Groetry and can be adapted to many other situations including analytic as opposed to generative as is the case for Groetry. Sourceverse is currently a pure javascript set of scripts that encompass the route from Chrome Bookmarks through a Bookmarklet towards Open Graph extraction of web data. This data is fed to AI models to produce verse, prompts and images. The outputs are captured as markdown posts in a Static Site Generator where they join other posts in a blog that can be curated and evolved further.

Sourceverse was developed through a series of conversations with XAI and Google AI models on X and in the Google AI Studio. This process could be regarded as Conversation Coding. Respecting the deep technological insights and large context windows of the models, one checks the output and carefully applies it in development, while implementing various ideas - often suggested by the models themselves - for further evolution.

### Sourceverse Scripts

- Bookmark Scripts for displaying general or topic based urls with Open Graph enhancements that use the most recent slices of the Chrome Bookmarks file.

- Browser Side Javascript for a bookmarklet based on 

[Obsidian Web Clipper Bookmarklet](https://gist.github.com/kepano/90c05f162c37cf730abb8ff027987ca3)

which creates json files with keys for text and images in web pages.

- A Nodejs based script based on Open Graph Scraper and other libraries which also create json files with source text, images and YouTube video transcripts.

- Nodejs bases scripts which send the values of keys in the json files to generative language models, and output markdown formatted files for a static site such as -

- Deno-based [theme-simple-blog](https://github.com/lumeland/theme-simple-blog) - A Simple Blog theme for [Lume](https://lume.land)

(optional) - Install additionally - or some other static site generator.

## Install

The project was developed in Linux and the following assumes installation to the home folder /home/username/ - replace username.


Install bun or nodejs, deno, and npm.

```bash

git clone https://github.com/owenkibel/sourceverse.git

cd sourceverse

npm install

// Either

git clone https://github.com/lumeland/theme-simple-blog

// Or

deno run -A https://lume.land/init.ts --theme=simple-blog

Welcome to Lume v2.5.1!

File saved: _data.yml
File saved: 404.md
File saved: favicon.png
File saved: posts/instructions.md

🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥

  BENVIDO - WELCOME! 🎉🎉🎉

  Lume has been configured successfully!
  Theme installed: Simple Blog

🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥

Quick start:

  deno task serve to start a local server
  deno task cms to start the CMS

See https://lume.land for online documentation
See https://discord.gg/YbTmpACHWB to propose new ideas and get help at Discord
See https://github.com/lumeland/lume to view the source code and report issues
See https://github.com/lumeland/theme-simple-blog to view the theme source code and report issues
See https://opencollective.com/lume to support Lume development

ln -s /home/username/sourceverse/theme-simple-blog/src/posts

cd /home/username/Downloads

mkdir jsonlet

mkdir ogs_data

cd /home/username/sourceverse

ln -s /home/username/Downloads/ogs_data

```

### Bookmarks

Edit the scripts bookmarksl.js and bookmarksm.js to point at the local OS Chrome Bookmarks file. If necessary edit the json path of the folder where the relevant bookmarks reside. Run the scripts with bun or node.

### Bookmarklet

Go to 

[Bookmarklet Maker](https://caiorss.github.io/bookmarklet-maker/)

Paste the contents of json1.js and xjson10.js into the box and follow directions on the page for each, creating different names for each bookmarklet.

The bookmarklet from json1.js downloads a tiny json with url information and is used in conjunction with url.js.

The bookmarklet from xjson10.js downloads a json with scraping information approximating [Obsidian Web Clipper Bookmarklet](https://gist.github.com/kepano/90c05f162c37cf730abb8ff027987ca3), but independently of Obsidian and in json format.

Visit web pages and YouTube videos with automatically generated subtitles to download with the json1.js bookmarklet.

Visit authorized web pages and social media sites which might resist the automatic combination of json1.js bookmarklet and url.js to download with the xjson10.js bookmarklet.

In the Downloads folder, move each downloaded tiny json from the json.js bookmarklet to the jsonlet folder.

In the Downloads folder, move each json from the xjson10.js bookmarklet to the ogs_data folder.

### Run

Once there are json files in /home/username/Downloads/json or /home/username/Downloads/ogs_data

In /home/username/sourceverse folder:

Bun or node is by preference.

```
bun url.js
```

- produces a json file in /home/username/sourceverse/ogs_data, the linked folder from /home/username/Downloads/ogs_data

There might already be a json file in ogs_data from the xjson10.js bookmarklet.

Run poellama.js after installing Ollama and some text generation and vision models.

Run goem.js after requesting a key for the [Google AI studio](https://aistudio.google.com/welcome) and export the key to environmental variable.

Run groem.js after requesting a key for [xAI](https://x.ai/) and export the key to environmental variable.

Also consider running the scripts that are named with consecutive numbers after their name such as groem4.js. Here, the embedded prompts have been separated and moved to an external prompts folder. Here they may be more easily inspected, edited and augmented for further development. The prompts are dynamically loaded and used by these later scripts. The latest goem5.js and groem4.js scripts also use the recently released image generation of their APIs to create embedded images in the blog markdown from the image generation prompts. If the APIs release video generation capability this could be later added. 

Generative AI files appear in the linked /home/username/sourceverse/posts folder.

See them as follows:

```
cd /home/username/sourceverse/theme-simple-blog

deno task serve
```

### Workflow

Two small javascripts are included to streamline the process of dealing with the json outputs of the Bookmarklets above. Edit the

```javascript
# Define the paths
downloads_dir="/path/to"
```
part of the jsonlscript.js and jsonxscript.js files to point to the location of the Chrome Browser Downloads folder.
The former script deals with the tiny json for general purpose and the latter with the Obsidian derived Bookmarklet output. These scripts will clear the folders and move each type of json into the correct places for further processing.

### X.ai Live Search

[Live Search](https://docs.x.ai/docs/guides/live-search)

Try groem16.js for adding Live Search on X to the context of posts etc. on that platform.


### Gemini API TTS

The latest goem script embeds an audio file using [Speech generation (text-to-speech)](https://ai.google.dev/gemini-api/docs/speech-generation). There are options to add audio effects to the generated voice audio. The ffmpeg binary is required for encoding a file with ping pong delay.

### Gemini API Video Audio Track Analysis

Now the script goem31.js sends an additional API request for analysis of audio tracks in YouTube and YouTube Music videos. Transcripts including speaker types are extracted, including lyrics of songs. Also printed is a short AI Music Generation prompt aimed at creating original music with some of the instruments, voices, tempo, tone and style of the original music video. This style is information is rudimentary and current music generators usually do their own thing anyway, but the results although very different, can sometimes be interesting. Although some music generators offer APIs, the present situation with music generation requires copy and paste into the generator.

### Video Generation

The latest goem scripts sends prompts to Veo 3 for creating embedded videos with sound. If an error occurs such as encountering a daily generation quota, the script should then attempt to create 2 embedded silent videos with Veo 2.

### comfyui-client
[comfyui-client](https://github.com/StableCanvas/comfyui-client) is used in the goemc scripts for image, video and music generation. Music generations are under the licences of <a href="https://github.com/ace-step/ACE-Step">ACE-Step</a> and <a href="https://github.com/declare-lab/jamify">Jamify</a>.

### AI Bookmark Groupings and Thread Exploration
The generate-links and vertical-thread scripts use a pipeline for examining a group of internet links, and then generating on the basis of discovered threads. Both ComfyUI z-image generations and Heartmula music generations are possible. 

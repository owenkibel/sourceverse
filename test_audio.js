import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import util from 'util';

const execFileAsync = util.promisify(execFile);

async function runTest() {
    // Grab the file from the command line arguments
    const inputFile = process.argv[2];

    if (!inputFile || !inputFile.endsWith('.flac')) {
        console.error("❌ Please provide a valid .flac file.\nUsage: bun test_audio.js path/to/Kokoro_Alternating_XXX.flac");
        process.exit(1);
    }

    const inputPath = path.resolve(inputFile);
    // Create an output filename based on the input
    const outputPath = inputPath.replace('.flac', '_tested.opus');

    // The filter graph to test. Tweak these values as much as you want!
    const filterGraph = [
        '[0:a]loudnorm=I=-16:TP=-1.5:LRA=11[norm]',
        '[norm]stereowiden=delay=15:crossfeed=0.3:drymix=0.8:feedback=0.3[wide]',
        '[wide]aecho=1.0:0.6:15|30:0.3|0.2[verb]',
        '[verb]alimiter=limit=-1.5dB[final_audio]'
    ].join(';');

    console.log(`\n🎧 Testing Spatial Audio on: ${path.basename(inputPath)}`);
    console.log(`⏳ Processing...`);

    try {
        await execFileAsync('ffmpeg', [
            '-y', 
            '-i', inputPath, 
            '-filter_complex', filterGraph, 
            '-map', '[final_audio]', 
            '-c:a', 'libopus', 
            '-b:a', '128k', 
            outputPath
        ]);
        
        console.log(`✅ Success! Output saved to:\n   ${outputPath}\n`);
    } catch (e) {
        console.error(`❌ FFmpeg Error:\n${e.stderr || e.message}`);
    }
}

runTest();
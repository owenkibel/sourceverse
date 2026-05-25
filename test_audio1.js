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
            // 1. Level the audio
            '[0:a]loudnorm=I=-16:TP=-1.5:LRA=11[norm]',
            
            // 2. The Glisten Engine (Harmonic Exciter): 
            // FFmpeg's 'crystalizer' expands the dynamic range of high frequencies, 
            // making transients (like 'T' and 'K' sounds) piercingly clear.
            '[norm]crystalizer=i=2.5[crisp]',
            
            // 3. The "Air" EQ: 
            // Adds a 4dB high-shelf boost starting at 5000Hz to make the audio sparkle.
            '[crisp]treble=g=4:f=5000:w=0.5[bright]',
            
            // 4. Tightened Stereo Widen: 
            // Delay reduced to 12ms. Keeps the 80/20 pan wide but focuses the core energy.
            '[bright]stereowiden=delay=12:crossfeed=0.2:drymix=0.8:feedback=0.3[wide]',
            
            // 5. Resonant Micro-Echo: 
            // Delays pulled back to 12ms and 24ms, and wet mix lowered slightly. 
            // This creates a bright, ringing resonance rather than a muddy room tail.
            '[wide]aecho=1.0:0.5:12|24:0.3|0.15[verb]',
            
            // 6. Final Limiter
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
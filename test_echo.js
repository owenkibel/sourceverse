const { execFile } = require('child_process');
const util = require('util');
const path = require('path');

const execFileAsync = util.promisify(execFile);

async function testAudioFilter() {
    // Change this to the exact name of the FLAC file currently in your images folder
    const inputFlac = path.join(__dirname, 'images', 'Kokoro_Gen_20260326193615_00001_.flac');
    const outputOpus = path.join(__dirname, 'images', 'test_pingpong.opus');

    console.log(`🎵 Processing ${inputFlac}...`);

    const filterGraph = [
        // 1. Normalize the mono input
        '[0:a]loudnorm=I=-16:TP=-1.5:LRA=11[norm]',
        
        // 2. Split into 3 paths
        '[norm]asplit=3[dry][echo_l][echo_r]',
        
        // 3. Dry center (mono c0 mapped to stereo c0 and c1)
        '[dry]pan=stereo|c0=c0|c1=c0[dry_st]',
        
        // // 4. Left bounce: Delay 300ms, drop volume to 60%.
        // // FIX: Mute the right channel using 0*c0
        // '[echo_l]adelay=300|300,volume=0.6,pan=stereo|c0=c0|c1=0*c0[L_out]',
        
        // // 5. Right bounce: Delay 600ms, drop volume to 36%.
        // // FIX: Mute the left channel using 0*c0
        // '[echo_r]adelay=600|600,volume=0.36,pan=stereo|c0=0*c0|c1=c0[R_out]',

        '[echo_l]adelay=100|100,volume=0.5,pan=stereo|c0=c0|c1=0*c0[L_out]',

        '[echo_r]adelay=200|200,volume=0.26,pan=stereo|c0=0*c0|c1=c0[R_out]',
        
        // 6. Mix them back together without auto-lowering the overall volume
        '[dry_st][L_out][R_out]amix=inputs=3:normalize=0[final_audio]'
    ].join(';');

    try {
        await execFileAsync('ffmpeg', [
            '-y', 
            '-i', inputFlac, 
            '-filter_complex', filterGraph, 
            '-map', '[final_audio]', 
            '-c:a', 'libopus', 
            '-b:a', '128k', 
            outputOpus
        ]);

        console.log(`✅ Success! Listen to ${outputOpus}`);
    } catch (err) {
        console.error("FFmpeg failed:", err.message);
    }
}

testAudioFilter();
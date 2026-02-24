#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');

// Define the paths
// !!! REMEMBER TO REPLACE "/path/to" WITH YOUR ACTUAL DIRECTORY !!!
const downloadsDir = "/path/to"; 
const ogsDataDir = path.join(downloadsDir, "ogs_data");
const jsonletDir = path.join(downloadsDir, "jsonlet");

async function main() {
    console.log(`Starting script for downloads directory: ${downloadsDir}`);

    // --- Step 1: Validate the base downloadsDir ---
    try {
        await fs.access(downloadsDir);
        console.log(`Downloads directory ${downloadsDir} is accessible.`);
    } catch (error) {
        console.error(`Error: downloads directory not found or not accessible: ${downloadsDir}`);
        console.error(error);
        process.exit(1); // Exit if the base directory isn't valid
    }

    // --- Step 2: Create the jsonlet directory if it doesn't exist ---
    // Equivalent to: mkdir -p "$jsonlet_dir"
    try {
        await fs.mkdir(jsonletDir, { recursive: true });
        console.log(`Ensured directory exists: ${jsonletDir}`);
    } catch (error) {
        console.error(`Error creating directory ${jsonletDir}:`, error);
        process.exit(1); // Exit on creation error
    }

    // --- Step 3: Clear the ogs_data directory contents ---
    // Equivalent to: find "$ogs_data_dir" -mindepth 1 -delete 2>/dev/null
    // This deletes contents but keeps the directory.
    try {
        // Use fs.rm with recursive: true and force: true to delete contents
        // force: true makes it silent if the directory or its contents don't exist (like 2>/dev/null)
        await fs.rm(ogsDataDir, { recursive: true, force: true });
        // Recreate the directory as the Bash command empties but doesn't remove the directory itself
        await fs.mkdir(ogsDataDir, { recursive: true });
        console.log(`Cleared and ensured directory exists: ${ogsDataDir}`);
    } catch (error) {
         console.error(`Error clearing/recreating directory ${ogsDataDir}:`, error);
         // Decide if this error is critical enough to stop. Logging and continuing might be okay.
         // For this example, we'll log and let the script continue.
    }

    // --- Step 4: Clear the jsonlet directory contents ---
    // Equivalent to: find "$jsonlet_dir" -mindepth 1 -delete 2>/dev/null
     try {
         // Use fs.rm with recursive: true and force: true to delete contents
         // force: true makes it silent if the directory or its contents don't exist (like 2>/dev/null)
         await fs.rm(jsonletDir, { recursive: true, force: true });
         // Recreate the directory as the Bash command empties but doesn't remove the directory itself
         await fs.mkdir(jsonletDir, { recursive: true });
         console.log(`Cleared and ensured directory exists: ${jsonletDir}`);
     } catch (error) {
         console.error(`Error clearing/recreating directory ${jsonletDir}:`, error);
         // Log and continue
     }

    // --- Step 5: Move .json files to jsonlet ---
    // Equivalent to: find "$downloads_dir" -maxdepth 1 -name "*.json" -print0 | xargs -0 -I {} mv {} "$jsonlet_dir"
    console.log(`Looking for *.json files in ${downloadsDir} to move to ${jsonletDir}...`);
    try {
        const files = await fs.readdir(downloadsDir);

        for (const file of files) {
            const sourcePath = path.join(downloadsDir, file);
            const destPath = path.join(jsonletDir, file);

            try {
                // Check if it's a file and ends with .json
                // fs.stat checks if it's a file/directory/etc.
                // endsWith('.json') replicates the "*.json" pattern
                const stat = await fs.stat(sourcePath);

                // Bash `find -maxdepth 1` only looks in the top directory, which fs.readdir does by default.
                // Bash `find -name "*.json"` matches files ending in .json.
                // Bash `mv` only moves files (or directories), not special file types.
                if (stat.isFile() && file.endsWith('.json')) {
                    await fs.rename(sourcePath, destPath); // fs.rename is used for moving/renaming
                    console.log(`Moved: ${sourcePath} -> ${destPath}`);
                }
            } catch (fileStatOrMoveError) {
                // Log errors for individual files but continue with others
                console.error(`Could not process file ${sourcePath}:`, fileStatOrMoveError.message);
            }
        }
        console.log(`Finished processing files in ${downloadsDir}.`);

    } catch (error) {
        console.error(`Error reading directory contents ${downloadsDir}:`, error);
        process.exit(1); // Exit if we can't even read the downloads directory
    }

    console.log("Script finished.");
}

// Execute the main async function
main().catch(err => {
    console.error("An unexpected error occurred:", err);
    process.exit(1);
});
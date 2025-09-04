const fs = require('fs').promises;
const path = require('path');

/**
 * The number of hours to subtract from the current timestamp.
 * Defaults to 24 hours.
 */
const RESET_HOURS = 24;

// --- Main Script Logic ---

const TIMESTAMP_FILENAME = 'last-bookmark-timestamp.txt';
const BACKUP_FILENAME = 'last-bookmark-timestamp.txt.bak';

// Calculate the offset in microseconds, as used by the Chrome timestamp format.
// We use BigInt (the 'n' suffix) to handle these large numbers safely.
const OFFSET_IN_MICROSECONDS = BigInt(RESET_HOURS) * 60n * 60n * 1000n * 1000n;

async function resetTimestamp() {
  console.log(`Starting timestamp reset for '${TIMESTAMP_FILENAME}'...`);

  try {
    // 1. Read the original timestamp file's content
    const originalTimestampStr = await fs.readFile(TIMESTAMP_FILENAME, 'utf8');
    const originalTimestamp = BigInt(originalTimestampStr.trim());

    console.log(`Read original timestamp: ${originalTimestamp}`);

    // 2. Back up the original file before making any changes
    await fs.copyFile(TIMESTAMP_FILENAME, BACKUP_FILENAME);
    console.log(`Successfully backed up original file to '${BACKUP_FILENAME}'`);

    // 3. Calculate the new, earlier timestamp
    const newTimestamp = originalTimestamp - OFFSET_IN_MICROSECONDS;

    // 4. Write the new timestamp back to the original file
    await fs.writeFile(TIMESTAMP_FILENAME, newTimestamp.toString());

    console.log(`\nSuccessfully reset timestamp!`);
    console.log(`  - Old value: ${originalTimestamp}`);
    console.log(`  - New value: ${newTimestamp} (${RESET_HOURS} hours earlier)`);

  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(`FATAL: The file '${TIMESTAMP_FILENAME}' was not found.`);
      console.error("Please ensure the file exists in the same directory as the script.");
    } else {
      console.error("An unexpected error occurred:", error);
    }
  }
}

// Run the main function
resetTimestamp();
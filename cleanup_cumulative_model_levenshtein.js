const fs = require('fs/promises');
const path = require('path');

const MODEL_PATH = 'cumulative_thread_model.json';
const BACKUP_DIR = 'backups';

// ==================== CONFIG ====================
const DRY_RUN = false;                    // Set to false to apply changes
const SIMILARITY_THRESHOLD = 0.72;       // 0.0–1.0 (higher = stricter). Levenshtein-based
const MAX_REPETITIVE_PATTERN = 4;        // Max repetitive "2.7× / browser-local" entries to keep
const MAX_TOTAL_HISTORY = 100;           // Hard cap on predictionHistory (0 = no limit)
const KEEP_LAST_PER_DOMAIN = 12;         // Trim dramaticPlays per domain
// ===============================================

// Levenshtein distance implementation
function levenshteinDistance(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix = [];

    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // substitution
                    matrix[i][j - 1] + 1,     // insertion
                    matrix[i - 1][j] + 1      // deletion
                );
            }
        }
    }

    return matrix[b.length][a.length];
}

function normalizedSimilarity(str1, str2) {
    const s1 = str1.toLowerCase().trim();
    const s2 = str2.toLowerCase().trim();

    if (s1 === s2) return 1.0;

    const maxLen = Math.max(s1.length, s2.length);
    if (maxLen === 0) return 1.0;

    const distance = levenshteinDistance(s1, s2);
    return 1 - (distance / maxLen);
}

function isRepetitivePattern(text) {
    return /2\.7|browser-local|monopoly vector|sub-150 ms|diffusion verification|chromatin-contact/i.test(text);
}

async function main() {
    console.log('🧹 Starting LEVENSHTEIN aggressive cleanup...');
    if (DRY_RUN) console.log('⚠️  DRY RUN MODE — No changes will be saved');

    let model;
    try {
        model = JSON.parse(await fs.readFile(MODEL_PATH, 'utf8'));
    } catch (e) {
        console.error('❌ Failed to read model file');
        process.exit(1);
    }

    // Backup
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(BACKUP_DIR, `cumulative_thread_model_${timestamp}.json`);
    await fs.writeFile(backupPath, JSON.stringify(model, null, 2));
    console.log(`✅ Backup created: ${backupPath}`);

    // === Clean predictionHistory with Levenshtein ===
    if (model.predictionHistory && Array.isArray(model.predictionHistory)) {
        const originalCount = model.predictionHistory.length;
        const cleaned = [];
        let repetitiveKept = 0;

        for (const entry of model.predictionHistory) {
            if (!entry.hypothesis) continue;

            // Check fuzzy similarity against already kept items
            let isDuplicate = false;
            for (const kept of cleaned) {
                const sim = normalizedSimilarity(entry.hypothesis, kept.hypothesis);
                if (sim > SIMILARITY_THRESHOLD) {
                    isDuplicate = true;
                    break;
                }
            }

            const repetitive = isRepetitivePattern(entry.hypothesis);

            if (!isDuplicate) {
                if (repetitive && repetitiveKept >= MAX_REPETITIVE_PATTERN) {
                    continue;
                }
                if (repetitive) repetitiveKept++;
                cleaned.push(entry);
            }
        }

        // Apply hard cap if set
        let finalHistory = cleaned;
        if (MAX_TOTAL_HISTORY > 0 && cleaned.length > MAX_TOTAL_HISTORY) {
            finalHistory = cleaned.slice(-MAX_TOTAL_HISTORY);
        }

        model.predictionHistory = finalHistory;
        console.log(`   predictionHistory: ${originalCount} → ${finalHistory.length} entries`);
    }

    // === Trim dramaticPlays ===
    if (model.dramaticPlays) {
        for (const domain of Object.keys(model.dramaticPlays)) {
            const arr = model.dramaticPlays[domain];
            if (Array.isArray(arr) && arr.length > KEEP_LAST_PER_DOMAIN) {
                model.dramaticPlays[domain] = arr.slice(-KEEP_LAST_PER_DOMAIN);
                console.log(`   dramaticPlays[${domain}]: trimmed to last ${KEEP_LAST_PER_DOMAIN}`);
            }
        }
    }

    // Write changes or dry-run
    if (!DRY_RUN) {
        await fs.writeFile(MODEL_PATH, JSON.stringify(model, null, 2));
        console.log('✅ Aggressive Levenshtein cleanup applied.');
    } else {
        console.log('✅ Dry run complete. No file was modified.');
        console.log('   Change DRY_RUN = false to apply changes.');
    }
}

main().catch(err => {
    console.error('Cleanup failed:', err);
    process.exit(1);
});
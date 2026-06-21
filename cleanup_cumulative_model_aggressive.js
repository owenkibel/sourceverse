const fs = require('fs/promises');
const path = require('path');

const MODEL_PATH = 'cumulative_thread_model.json';
const BACKUP_DIR = 'backups';

// ==================== CONFIG ====================
const DRY_RUN = false;                    // Set to false to actually write changes
const SIMILARITY_THRESHOLD = 0.65;       // 0.0–1.0 (higher = stricter). 0.65 is aggressive
const MAX_REPETITIVE_PATTERN = 5;        // Max number of "2.7× / browser-local" style entries to keep
const MAX_TOTAL_HISTORY = 120;           // Hard cap on predictionHistory (0 = no cap)
const KEEP_LAST_PER_DOMAIN = 12;         // Trim dramaticPlays to last N per domain
// ===============================================

function jaccardSimilarity(a, b) {
    const setA = new Set(a.toLowerCase().split(/\s+/));
    const setB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return union.size === 0 ? 0 : intersection.size / union.size;
}

function isRepetitivePattern(text) {
    return /2\.7|browser-local|monopoly vector|sub-150 ms|diffusion verification|chromatin-contact/i.test(text);
}

async function main() {
    console.log('🧹 Starting AGGRESSIVE cumulative model cleanup...');
    if (DRY_RUN) console.log('⚠️  DRY RUN MODE — No changes will be written');

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
    console.log(`✅ Backup saved to ${backupPath}`);

    // === Clean predictionHistory ===
    if (model.predictionHistory && Array.isArray(model.predictionHistory)) {
        const originalCount = model.predictionHistory.length;
        let cleaned = [];
        let repetitiveCount = 0;

        for (const entry of model.predictionHistory) {
            if (!entry.hypothesis) continue;

            // Check similarity against already kept items
            let isDuplicate = false;
            for (const kept of cleaned) {
                if (jaccardSimilarity(entry.hypothesis, kept.hypothesis) > SIMILARITY_THRESHOLD) {
                    isDuplicate = true;
                    break;
                }
            }

            const repetitive = isRepetitivePattern(entry.hypothesis);

            if (!isDuplicate) {
                if (repetitive && repetitiveCount >= MAX_REPETITIVE_PATTERN) {
                    continue; // Drop excess repetitive entries
                }
                if (repetitive) repetitiveCount++;
                cleaned.push(entry);
            }
        }

        // Optional hard cap
        if (MAX_TOTAL_HISTORY > 0 && cleaned.length > MAX_TOTAL_HISTORY) {
            cleaned = cleaned.slice(-MAX_TOTAL_HISTORY);
        }

        model.predictionHistory = cleaned;
        console.log(`   predictionHistory: ${originalCount} → ${cleaned.length} entries`);
    }

    // === Trim dramaticPlays per domain ===
    if (model.dramaticPlays) {
        for (const domain of Object.keys(model.dramaticPlays)) {
            const arr = model.dramaticPlays[domain];
            if (Array.isArray(arr) && arr.length > KEEP_LAST_PER_DOMAIN) {
                model.dramaticPlays[domain] = arr.slice(-KEEP_LAST_PER_DOMAIN);
                console.log(`   dramaticPlays[${domain}]: trimmed to last ${KEEP_LAST_PER_DOMAIN}`);
            }
        }
    }

    // Write or dry-run
    if (!DRY_RUN) {
        await fs.writeFile(MODEL_PATH, JSON.stringify(model, null, 2));
        console.log('✅ Aggressive cleanup written to disk.');
    } else {
        console.log('✅ Dry run complete. No file was modified.');
        console.log('   Set DRY_RUN = false to apply changes.');
    }
}

main().catch(err => {
    console.error('Cleanup failed:', err);
    process.exit(1);
});
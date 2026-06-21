const fs = require('fs/promises');
const path = require('path');

const MODEL_PATH = 'cumulative_thread_model.json';
const BACKUP_DIR = 'backups';

async function main() {
    console.log('🧹 Starting cumulative model cleanup...');

    // 1. Load current model
    let model;
    try {
        const raw = await fs.readFile(MODEL_PATH, 'utf8');
        model = JSON.parse(raw);
    } catch (e) {
        console.error('❌ Could not read cumulative_thread_model.json');
        process.exit(1);
    }

    // 2. Create backup
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(BACKUP_DIR, `cumulative_thread_model_${timestamp}.json`);
    await fs.writeFile(backupPath, JSON.stringify(model, null, 2));
    console.log(`✅ Backup created: ${backupPath}`);

    // 3. Clean predictionHistory
    if (model.predictionHistory && Array.isArray(model.predictionHistory)) {
        const originalCount = model.predictionHistory.length;

        const cleaned = [];
        const seen = new Set();

        const normalize = (text) => text.toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        for (const entry of model.predictionHistory) {
            if (!entry.hypothesis) continue;

            const norm = normalize(entry.hypothesis);

            // Skip near-duplicates
            let isDuplicate = false;
            for (const existing of seen) {
                const overlap = norm.split(' ').filter(w => existing.includes(w)).length;
                if (overlap > 8) {
                    isDuplicate = true;
                    break;
                }
            }

            // Heavily filter repetitive patterns
            const isRepetitive = /2\.7|browser-local|monopoly vector|sub-150 ms|diffusion verification/i.test(entry.hypothesis);

            if (!isDuplicate && (!isRepetitive || cleaned.length < 8)) {
                seen.add(norm);
                cleaned.push(entry);
            }
        }

        model.predictionHistory = cleaned;
        console.log(`   predictionHistory: ${originalCount} → ${cleaned.length} entries`);
    }

    // 4. Optional: Trim very old dramaticPlays entries per domain (keep last 15)
    if (model.dramaticPlays) {
        for (const domain of Object.keys(model.dramaticPlays)) {
            const plays = model.dramaticPlays[domain];
            if (Array.isArray(plays) && plays.length > 15) {
                model.dramaticPlays[domain] = plays.slice(-15);
                console.log(`   dramaticPlays[${domain}]: trimmed to last 15 entries`);
            }
        }
    }

    // 5. Save cleaned model
    await fs.writeFile(MODEL_PATH, JSON.stringify(model, null, 2));
    console.log('✅ Cleanup complete. Model saved.');
    console.log(`   Backup preserved at: ${backupPath}`);
}

main().catch(err => {
    console.error('Cleanup failed:', err);
    process.exit(1);
});
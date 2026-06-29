const fs = require('fs/promises');
const path = require('path');

const MODEL_PATH = 'cumulative_thread_model.json';
const BACKUP_DIR = 'backups';

const DRY_RUN = false; // Set to false to apply changes

async function main() {
    console.log('🧹 Starting cleanup of keyThemes and actHistory from narrativeArcs...\n');

    if (DRY_RUN) {
        console.log('⚠️  DRY RUN MODE — No changes will be saved\n');
    }

    let model;
    try {
        model = JSON.parse(await fs.readFile(MODEL_PATH, 'utf8'));
    } catch (e) {
        console.error('❌ Failed to read cumulative_thread_model.json');
        process.exit(1);
    }

    // Create backup
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(BACKUP_DIR, `cumulative_thread_model_${timestamp}.json`);
    await fs.writeFile(backupPath, JSON.stringify(model, null, 2));
    console.log(`✅ Backup created: ${backupPath}\n`);

    let domainsCleaned = 0;
    let keysRemoved = 0;

    if (model.narrativeArcs) {
        for (const domain of Object.keys(model.narrativeArcs)) {
            const arc = model.narrativeArcs[domain];
            let changed = false;

            if (arc.keyThemes !== undefined) {
                delete arc.keyThemes;
                changed = true;
                keysRemoved++;
            }

            if (arc.actHistory !== undefined) {
                delete arc.actHistory;
                changed = true;
                keysRemoved++;
            }

            if (changed) {
                domainsCleaned++;
                console.log(`   Cleaned domain: ${domain}`);
            }
        }
    }

    console.log(`\n📊 Summary:`);
    console.log(`   Domains cleaned: ${domainsCleaned}`);
    console.log(`   Keys removed:    ${keysRemoved}`);

    if (!DRY_RUN && keysRemoved > 0) {
        await fs.writeFile(MODEL_PATH, JSON.stringify(model, null, 2));
        console.log('\n✅ Changes written to cumulative_thread_model.json');
    } else if (DRY_RUN) {
        console.log('\n✅ Dry run complete. No file was modified.');
        console.log('   Set DRY_RUN = false to apply changes.');
    } else {
        console.log('\nℹ️  No keys found to remove.');
    }
}

main().catch(err => {
    console.error('Cleanup failed:', err);
    process.exit(1);
});
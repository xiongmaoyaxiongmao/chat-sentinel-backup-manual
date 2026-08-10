#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const {
    InventoryOwner,
    INDEX_FILE,
} = require('../plugins/chat-sentinel-backup/lib/inventory.cjs');
const {
    ROLLING_SLOT_COUNT,
    contentHash,
    writeRollingSnapshot,
} = require('../plugins/chat-sentinel-backup/lib/snapshot-service.cjs');
const { validateJsonlText } = require('../plugins/chat-sentinel-backup/lib/jsonl.cjs');

function usage() {
    console.error('Usage: node scripts/migrate-legacy-to-rolling.cjs --snapshot-dir <directory> [--apply]');
}

function parseArguments(argv) {
    const result = { apply: false, snapshotDir: '' };
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === '--apply') result.apply = true;
        if (value === '--snapshot-dir') result.snapshotDir = argv[index + 1] || '';
    }
    return result;
}

function legacySnapshots(index) {
    return Object.values(index.snapshots)
        .filter((item) => !Number.isInteger(item.slot));
}

function migrationPlan(index) {
    if (Object.values(index.rolling?.chats || {}).some((state) => state.slots?.length)) {
        throw new Error('已存在循环保护点；拒绝混合或重复迁移。');
    }

    const byChat = new Map();
    for (const item of legacySnapshots(index)) {
        if (item.trashedAt) continue;
        if (!byChat.has(item.canonicalId)) byChat.set(item.canonicalId, []);
        byChat.get(item.canonicalId).push(item);
    }

    const selected = [];
    for (const [canonicalId, snapshots] of byChat) {
        snapshots.sort((left, right) => right.mtimeMs - left.mtimeMs);
        selected.push(...snapshots.slice(0, ROLLING_SLOT_COUNT));
        if (!index.chats[canonicalId] || index.chats[canonicalId].legacy) {
            throw new Error(`快照 ${snapshots[0]?.name || canonicalId} 缺少可恢复的聊天身份。`);
        }
    }
    return { legacy: legacySnapshots(index), selected, chatCount: byChat.size };
}

async function readSource(snapshotDir, item) {
    const filePath = path.join(snapshotDir, item.name);
    const text = await fs.promises.readFile(filePath, 'utf8');
    const parsed = validateJsonlText(text);
    return {
        text,
        messageCount: parsed.messageCount,
        bytes: Buffer.byteLength(text, 'utf8'),
    };
}

async function main() {
    const { apply, snapshotDir } = parseArguments(process.argv.slice(2));
    if (!snapshotDir) {
        usage();
        process.exitCode = 2;
        return;
    }
    const resolvedDir = path.resolve(snapshotDir);
    const indexPath = path.join(resolvedDir, INDEX_FILE);
    const index = JSON.parse(await fs.promises.readFile(indexPath, 'utf8'));
    const plan = migrationPlan(index);
    const totalBytes = plan.legacy.reduce((total, item) => total + (item.bytes || 0), 0);
    const retainedBytes = plan.selected.reduce((total, item) => total + (item.bytes || 0), 0);
    const report = {
        snapshotDir: resolvedDir,
        chats: plan.chatCount,
        legacySnapshots: plan.legacy.length,
        retainedSnapshots: plan.selected.length,
        deletedSnapshots: plan.legacy.length - plan.selected.length,
        retainedBytes,
        reclaimBytes: totalBytes - retainedBytes,
        applied: apply,
    };
    if (!apply) {
        console.log(JSON.stringify(report, null, 2));
        return;
    }

    const inventory = new InventoryOwner();
    const result = await inventory.mutate(resolvedDir, async (working, transaction) => {
        const currentPlan = migrationPlan(working);
        for (const item of currentPlan.selected) {
            const chat = working.chats[item.canonicalId];
            const source = await readSource(resolvedDir, item);
            const saved = await writeRollingSnapshot(working, transaction, resolvedDir, {
                canonicalId: chat.canonicalId,
                kind: chat.kind,
                entityName: chat.entityName,
            }, source, item.status || 'auto');
            const written = await fs.promises.readFile(path.join(resolvedDir, saved.file), 'utf8');
            if (contentHash(written) !== contentHash(source.text)) {
                throw new Error(`循环槽校验失败：${saved.file}`);
            }
        }
        for (const item of currentPlan.legacy) {
            await transaction.stageDelete(path.join(resolvedDir, item.name));
            delete working.snapshots[item.name];
        }
        return {
            migrated: currentPlan.selected.length,
            removed: currentPlan.legacy.length - currentPlan.selected.length,
        };
    });
    console.log(JSON.stringify({ ...report, ...result, applied: true }, null, 2));
}

main().catch((error) => {
    console.error(`[chat-sentinel-backup] migration failed: ${error.message}`);
    process.exitCode = 1;
});

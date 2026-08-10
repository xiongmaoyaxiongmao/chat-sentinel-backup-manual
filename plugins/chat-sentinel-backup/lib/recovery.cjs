const fs = require('node:fs');
const path = require('node:path');
const {
    isPathInside,
    snapshotDirectory,
    userDirectories,
} = require('./identity.cjs');
const { validateJsonlText } = require('./jsonl.cjs');
const { contentHash, managedSnapshot, writeRollingSnapshot } = require('./snapshot-service.cjs');

async function stagedGroupRegistration(request, identity, transaction) {
    if (!identity.isGroup) return null;
    const directories = userDirectories(request);
    if (!directories.groups) return null;
    const groupPath = path.join(directories.groups, `${identity.entityId}.json`);
    if (!isPathInside(directories.groups, groupPath)) throw new Error('group path is invalid');
    let raw;
    try {
        raw = await fs.promises.readFile(groupPath, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    const group = JSON.parse(raw);
    group.chats = Array.isArray(group.chats) ? group.chats : [];
    if (!group.chats.includes(identity.chatId)) group.chats.push(identity.chatId);
    group.chat_id ||= identity.chatId;
    await transaction.stageReplace(groupPath, `${JSON.stringify(group, null, 4)}\n`);
    return path.basename(groupPath);
}

class RecoveryService {
    constructor(inventory, hooks = {}) {
        this.inventory = inventory;
        this.hooks = hooks;
    }

    async restore(request, body) {
        const snapshotDir = snapshotDirectory(request);
        return this.inventory.mutate(snapshotDir, async (index, transaction) => {
            const identity = this.inventory.resolveCurrentTarget(index, request, body.opaqueKey);
            const sourceName = path.basename(String(body.name || ''));
            const managed = managedSnapshot(index, sourceName);
            const sourceRecord = managed?.item;
            if (!sourceRecord || sourceRecord.canonicalId !== identity.canonicalId) {
                throw new Error('快照身份与目标聊天不一致');
            }
            const sourcePath = path.join(snapshotDir, sourceName);
            if (!isPathInside(snapshotDir, sourcePath)) throw new Error('snapshot path is invalid');
            const sourceText = await fs.promises.readFile(sourcePath, 'utf8');
            const source = validateJsonlText(sourceText);

            let originalText = null;
            let preRestoreName = null;
            try {
                originalText = await fs.promises.readFile(identity.targetPath, 'utf8');
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }

            if (originalText !== null) {
                let originalCount = 0;
                try {
                    originalCount = validateJsonlText(originalText, { allowHeaderOnly: true }).messageCount;
                } catch {
                    originalCount = 0;
                }
                const saved = await writeRollingSnapshot(index, transaction, snapshotDir, identity, {
                    text: originalText,
                    messageCount: originalCount,
                    bytes: Buffer.byteLength(originalText, 'utf8'),
                }, 'pre-restore');
                preRestoreName = saved.file;
            }

            await fs.promises.mkdir(path.dirname(identity.targetPath), { recursive: true });
            await transaction.stageReplace(identity.targetPath, sourceText);
            await this.hooks.afterReplace?.({ request, identity, sourceName });
            const groupMetadata = await stagedGroupRegistration(request, identity, transaction);

            const chat = index.chats[identity.canonicalId];
            chat.deletedAt = null;
            chat.latestContentHash = contentHash(sourceText);
            chat.updatedAt = new Date().toISOString();
            for (const item of Object.values(index.snapshots)) {
                if (item.canonicalId === identity.canonicalId && item.trashReason === 'chat-deleted') {
                    item.trashedAt = null;
                    item.trashReason = null;
                }
            }

            return {
                restored: sourceName,
                target: path.basename(identity.targetPath),
                targetPathSemantic: identity.pathSemantic,
                preRestoreSnapshot: preRestoreName,
                groupMetadata,
                messageCount: source.messageCount,
                result: 'restored',
            };
        });
    }

    async restoreDeleted(request, name) {
        const snapshotDir = snapshotDirectory(request);
        const data = await this.inventory.read(snapshotDir, (index) => {
            const safeName = path.basename(String(name || ''));
            const snapshot = index.snapshots[safeName];
            if (!snapshot?.trashedAt || snapshot.trashReason !== 'chat-deleted') {
                throw new Error('回收站中没有这个聊天快照');
            }
            this.inventory.findIdentityByOpaque(index, snapshot.canonicalId);
            return { name: safeName, opaqueKey: snapshot.canonicalId };
        });
        return this.restore(request, data);
    }
}

module.exports = { RecoveryService, stagedGroupRegistration };

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sanitizeFilename = require('sanitize-filename');
const {
    cleanLabel,
    isPathInside,
    plainFileId,
    resolveChatIdentity,
    snapshotDirectory,
    stableEntityId,
    userDirectories,
} = require('./identity.cjs');
const { validateJsonlText, previewFromText } = require('./jsonl.cjs');

const DEFAULT_KEEP = 80;
const MAX_KEEP = 500;
const REGRESSION_MIN_BASELINE = 20;
const REGRESSION_MIN_DROP = 20;
const REGRESSION_MAX_RATIO = 0.25;
const STABLE_ATTEMPTS = 5;
const STABLE_DELAY_MS = 120;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function contentHash(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function compactStamp(date = new Date()) {
    return date.toISOString().replace(/[-:.]/g, '');
}

function snapshotName(identity, messageCount, status) {
    const unique = crypto.randomBytes(8).toString('hex');
    return `${compactStamp()}__${identity.kind}__${cleanLabel(identity.entityName)}__c${identity.canonicalId}`
        + `__u${unique}__m${messageCount}__${status}.jsonl`;
}

function isSuspicious(current, baseline) {
    return baseline >= REGRESSION_MIN_BASELINE
        && baseline - current >= REGRESSION_MIN_DROP
        && current <= Math.floor(baseline * REGRESSION_MAX_RATIO);
}

async function readStableChatFile(filePath) {
    for (let attempt = 0; attempt < STABLE_ATTEMPTS; attempt += 1) {
        let before;
        try {
            before = await fs.promises.stat(filePath);
        } catch (error) {
            if (error.code === 'ENOENT') throw new Error('当前聊天尚未保存到服务器。');
            throw error;
        }
        const text = await fs.promises.readFile(filePath, 'utf8');
        const after = await fs.promises.stat(filePath);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
            await sleep(STABLE_DELAY_MS);
            continue;
        }
        return { text, ...validateJsonlText(text), mtimeMs: after.mtimeMs };
    }
    throw new Error('当前聊天文件仍在写入，请稍后重试。');
}

function publicChat(chat) {
    return {
        opaqueKey: chat.canonicalId,
        kind: chat.kind,
        entityId: chat.entityId,
        entityName: chat.entityName,
        chatId: chat.chatId,
        deletedAt: chat.deletedAt || null,
        updatedAt: chat.updatedAt,
    };
}

function publicSnapshot(item) {
    return {
        name: item.name,
        opaqueKey: item.canonicalId,
        messageCount: item.messageCount,
        size: item.bytes,
        mtimeMs: item.mtimeMs,
        createdAt: item.createdAt,
        kept: Boolean(item.kept),
        status: item.status,
        trashedAt: item.trashedAt || null,
        trashReason: item.trashReason || null,
    };
}

function snapshotsFor(index, canonicalId, includeTrashed = false) {
    return Object.values(index.snapshots)
        .filter((item) => item.canonicalId === canonicalId)
        .filter((item) => includeTrashed || !item.trashedAt)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function renamedChatId(value, label) {
    // CHAT_RENAMED carries the user's raw filename.  SillyTavern persists the
    // sanitized filename, so remap only the exact name the host can have made.
    return plainFileId(path.parse(sanitizeFilename(String(value || ''))).name, label);
}

async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    async function run() {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await worker(items[index], index);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return results;
}

class SnapshotService {
    constructor(inventory) {
        this.inventory = inventory;
    }

    async registerIdentity(request, body) {
        const identity = resolveChatIdentity(request, body);
        const snapshotDir = snapshotDirectory(request);
        return this.inventory.mutate(snapshotDir, (index) => {
            const chat = this.inventory.adoptIdentity(index, identity);
            return { opaqueKey: chat.canonicalId, identity: publicChat(chat) };
        });
    }

    async resolveOpaque(request, opaqueKey) {
        const snapshotDir = snapshotDirectory(request);
        return this.inventory.read(snapshotDir, (index) =>
            this.inventory.resolveCurrentTarget(index, request, opaqueKey));
    }

    async storeText(request, body, identity, source, status = 'manual') {
        const snapshotDir = snapshotDirectory(request);
        const keepLimit = Math.max(5, Math.min(Number(body.keepPerChat) || DEFAULT_KEEP, MAX_KEEP));
        const hash = contentHash(source.text);
        return this.inventory.mutate(snapshotDir, async (index, transaction) => {
            const chat = this.inventory.adoptIdentity(index, identity);
            const adoptedIdentity = { ...identity, canonicalId: chat.canonicalId };
            const allExisting = snapshotsFor(index, chat.canonicalId, true);
            const existing = allExisting.filter((item) => !item.trashedAt);
            const baseline = existing.reduce((max, item) => Math.max(max, item.messageCount || 0), 0);
            const suspicious = isSuspicious(source.messageCount, baseline);

            if (suspicious && body.confirmRegression !== true) {
                const error = new Error(`检测到当前聊天从 ${baseline} 条骤降到 ${source.messageCount} 条，已拒绝自动保存。`);
                error.statusCode = 409;
                error.code = 'message_count_regression';
                error.details = { baselineMessageCount: baseline, currentMessageCount: source.messageCount };
                throw error;
            }

            const duplicate = allExisting.find((item) => item.contentHash && item.contentHash === hash);
            if (duplicate) {
                duplicate.trashedAt = null;
                duplicate.trashReason = null;
                chat.deletedAt = null;
                chat.latestContentHash = hash;
                return {
                    ok: true,
                    skipped: true,
                    reason: 'duplicate',
                    opaqueKey: chat.canonicalId,
                    directory: snapshotDir,
                };
            }

            if (suspicious) {
                const baselineSnapshot = existing.find((item) => item.messageCount === baseline);
                if (baselineSnapshot) baselineSnapshot.kept = true;
                status = 'confirmed';
            }

            const name = snapshotName(adoptedIdentity, source.messageCount, status);
            await transaction.stageCreate(path.join(snapshotDir, name), source.text);
            const now = Date.now();
            index.snapshots[name] = {
                name,
                canonicalId: chat.canonicalId,
                kind: adoptedIdentity.kind,
                label: adoptedIdentity.entityName,
                legacyId: '',
                messageCount: source.messageCount,
                bytes: source.bytes,
                mtimeMs: now,
                createdAt: new Date(now).toISOString(),
                status,
                kept: status === 'pre-restore',
                trashedAt: null,
                trashReason: null,
                contentHash: hash,
            };
            Object.assign(chat, {
                entityName: identity.entityName,
                chatId: identity.chatId,
                pathSemantic: identity.pathSemantic,
                deletedAt: null,
                latestContentHash: hash,
                updatedAt: new Date(now).toISOString(),
            });

            let retentionDeferred = false;
            if (index.health.destructiveBlocked) {
                retentionDeferred = true;
            } else {
                const removable = snapshotsFor(index, chat.canonicalId)
                    .filter((item) => item.status !== 'legacy'
                        && !item.kept
                        && !item.trashedAt
                        && item.status !== 'pre-restore');
                for (const stale of removable.slice(keepLimit)) {
                    await transaction.stageDelete(path.join(snapshotDir, stale.name));
                    delete index.snapshots[stale.name];
                }
            }

            return {
                ok: true,
                skipped: false,
                file: name,
                opaqueKey: chat.canonicalId,
                directory: snapshotDir,
                source: path.basename(adoptedIdentity.targetPath),
                messageCount: source.messageCount,
                bytes: source.bytes,
                status,
                retentionDeferred,
                regression: suspicious ? {
                    confirmed: true,
                    baselineMessageCount: baseline,
                    currentMessageCount: source.messageCount,
                } : null,
            };
        });
    }

    async snapshot(request, body, status = null) {
        const identity = await this.resolveOpaque(request, body.opaqueKey);
        const source = await readStableChatFile(identity.targetPath);
        const resolvedStatus = status || (body.reason === 'manual' ? 'manual' : 'auto');
        return this.storeText(request, body, identity, source, resolvedStatus);
    }

    async entityChatFiles(request, identity) {
        const directories = userDirectories(request);
        if (identity.isGroup) {
            const groupPath = path.join(directories.groups, `${identity.entityId}.json`);
            if (!isPathInside(directories.groups, groupPath)) throw new Error('group path is invalid');
            let group;
            try {
                group = JSON.parse(await fs.promises.readFile(groupPath, 'utf8'));
            } catch (error) {
                if (error.code === 'ENOENT') return [];
                throw error;
            }
            return (Array.isArray(group.chats) ? group.chats : []).map((id) => {
                const chatId = plainFileId(id, 'chat id');
                return path.join(directories.groupChats, `${chatId}.jsonl`);
            }).filter((filePath) => isPathInside(directories.groupChats, filePath));
        }
        try {
            return (await fs.promises.readdir(identity.entityRoot))
                .filter((name) => name.endsWith('.jsonl'))
                .map((name) => path.join(identity.entityRoot, name))
                .filter((filePath) => isPathInside(identity.entityRoot, filePath));
        } catch (error) {
            if (error.code === 'ENOENT') return [];
            throw error;
        }
    }

    async entityIdentities(request, opaqueKey) {
        const base = await this.resolveOpaque(request, opaqueKey);
        const files = await this.entityChatFiles(request, base);
        const identities = files.map((filePath) => resolveChatIdentity(request, {
            isGroup: base.isGroup,
            entityId: base.entityId,
            entityName: base.entityName,
            chatId: path.basename(filePath, '.jsonl'),
        }));
        const snapshotDir = snapshotDirectory(request);
        return this.inventory.mutate(snapshotDir, (index) =>
            identities.map((identity) => ({
                ...identity,
                canonicalId: this.inventory.adoptIdentity(index, identity).canonicalId,
            })));
    }

    async remapCharacter(request, body) {
        const oldEntityId = stableEntityId({ isGroup: false, entityId: body.oldAvatar });
        const newEntityId = stableEntityId({ isGroup: false, entityId: body.newAvatar });
        const snapshotDir = snapshotDirectory(request);
        return this.inventory.mutate(snapshotDir, (index) =>
            this.inventory.remapCharacter(index, oldEntityId, newEntityId));
    }

    async remapChat(request, body) {
        const isGroup = body.isGroup === true;
        const entityId = body.entityId;
        const entityName = body.entityName || (isGroup ? '群聊' : '角色');
        const oldIdentity = resolveChatIdentity(request, {
            isGroup,
            entityId,
            entityName,
            chatId: renamedChatId(body.oldFileName, 'old chat id'),
        });
        const newIdentity = resolveChatIdentity(request, {
            isGroup,
            entityId,
            entityName,
            chatId: renamedChatId(body.newFileName, 'new chat id'),
        });
        try {
            const stat = await fs.promises.stat(newIdentity.targetPath);
            if (!stat.isFile()) throw new Error('renamed chat target is not a file');
        } catch (error) {
            const unavailable = new Error('renamed chat target is unavailable');
            unavailable.statusCode = 409;
            unavailable.code = 'canonical_target_unavailable';
            throw unavailable;
        }
        const snapshotDir = snapshotDirectory(request);
        return this.inventory.mutate(snapshotDir, (index) =>
            this.inventory.remapChat(index, oldIdentity, newIdentity));
    }

    async entityChats(request, body) {
        const identities = await this.entityIdentities(request, body.opaqueKey);
        const summaries = await mapLimit(identities, 4, async (identity) => {
            const [stat, text] = await Promise.all([
                fs.promises.stat(identity.targetPath),
                fs.promises.readFile(identity.targetPath, 'utf8'),
            ]);
            const parsed = validateJsonlText(text, { allowHeaderOnly: true });
            return {
                opaqueKey: identity.canonicalId,
                name: identity.chatId,
                messageCount: parsed.messageCount,
                size: stat.size,
                mtimeMs: stat.mtimeMs,
            };
        });
        return summaries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    }

    async snapshotMany(request, body, selectedOpaqueKeys = null) {
        let identities = await this.entityIdentities(request, body.opaqueKey);
        if (selectedOpaqueKeys) {
            const allowed = new Set(selectedOpaqueKeys.map(String));
            identities = identities.filter((identity) => allowed.has(identity.canonicalId));
        }
        const outcomes = await mapLimit(identities, 4, async (identity) => {
            try {
                const source = await readStableChatFile(identity.targetPath);
                return await this.storeText(request, body, identity, source, 'manual');
            } catch (error) {
                return { ok: false, opaqueKey: identity.canonicalId, error: error.message };
            }
        });
        return {
            total: identities.length,
            written: outcomes.filter((item) => item.ok && !item.skipped).length,
            skipped: outcomes.filter((item) => !item.ok || item.skipped).length,
            snapshots: outcomes,
        };
    }

    async current(request, body) {
        const identity = await this.resolveOpaque(request, body.opaqueKey);
        const snapshotDir = snapshotDirectory(request);
        return this.inventory.read(snapshotDir, (index) => {
            const chat = this.inventory.findIdentityByOpaque(index, identity.canonicalId);
            return {
                identity: publicChat(chat),
                snapshots: snapshotsFor(index, identity.canonicalId).map(publicSnapshot),
                directory: snapshotDir,
            };
        });
    }

    async history(request) {
        const snapshotDir = snapshotDirectory(request);
        return this.inventory.read(snapshotDir, (index) => ({
            directory: snapshotDir,
            groups: Object.values(index.chats).map((chat) => ({
                ...publicChat(chat),
                snapshots: snapshotsFor(index, chat.canonicalId).map(publicSnapshot),
            })).filter((group) => group.snapshots.length > 0)
                .sort((a, b) => (b.snapshots[0]?.mtimeMs || 0) - (a.snapshots[0]?.mtimeMs || 0)),
            quarantine: Object.values(index.quarantine),
            pendingReview: Object.values(index.review),
        }));
    }

    async trash(request) {
        const snapshotDir = snapshotDirectory(request);
        return this.inventory.read(snapshotDir, (index) => ({
            directory: snapshotDir,
            snapshots: Object.values(index.snapshots)
                .filter((item) => item.trashedAt)
                .sort((a, b) => Date.parse(b.trashedAt) - Date.parse(a.trashedAt))
                .map((item) => ({
                    ...publicSnapshot(item),
                    chat: index.chats[item.canonicalId] ? publicChat(index.chats[item.canonicalId]) : null,
                })),
            quarantine: Object.values(index.quarantine),
        }));
    }

    async setKept(request, body, kept) {
        const identity = await this.resolveOpaque(request, body.opaqueKey);
        const selected = new Set((body.selected || []).map((name) => path.basename(String(name))));
        const snapshotDir = snapshotDirectory(request);
        return this.inventory.mutate(snapshotDir, (index) => {
            this.inventory.findIdentityByOpaque(index, identity.canonicalId);
            let changed = 0;
            for (const name of selected) {
                const item = index.snapshots[name];
                if (item?.canonicalId !== identity.canonicalId || item.trashedAt) continue;
                item.kept = kept;
                changed += 1;
            }
            return { changed, snapshots: snapshotsFor(index, identity.canonicalId).map(publicSnapshot) };
        });
    }

    async moveToTrash(request, body) {
        const identity = await this.resolveOpaque(request, body.opaqueKey);
        const selected = new Set((body.selected || []).map((name) => path.basename(String(name))));
        const snapshotDir = snapshotDirectory(request);
        return this.inventory.mutate(snapshotDir, (index) => {
            this.inventory.assertDestructiveAllowed(snapshotDir, index, '移动到回收站');
            let changed = 0;
            for (const name of selected) {
                const item = index.snapshots[name];
                if (item?.canonicalId !== identity.canonicalId || item.status === 'pre-restore') continue;
                item.trashedAt = new Date().toISOString();
                item.trashReason = 'version-deleted';
                changed += 1;
            }
            return { changed };
        });
    }

    async restoreTrash(request, names) {
        const selected = new Set((names || []).map((name) => path.basename(String(name))));
        const snapshotDir = snapshotDirectory(request);
        return this.inventory.mutate(snapshotDir, (index) => {
            let restored = 0;
            for (const name of selected) {
                const item = index.snapshots[name];
                if (!item?.trashedAt) continue;
                item.trashedAt = null;
                item.trashReason = null;
                restored += 1;
            }
            return { restored };
        });
    }

    async purgeTrash(request, names) {
        const selected = new Set((names || []).map((name) => path.basename(String(name))));
        const snapshotDir = snapshotDirectory(request);
        return this.inventory.mutate(snapshotDir, async (index, transaction) => {
            this.inventory.assertDestructiveAllowed(snapshotDir, index, '永久删除');
            let purged = 0;
            for (const name of selected) {
                const item = index.snapshots[name];
                if (!item?.trashedAt) continue;
                await transaction.stageDelete(path.join(snapshotDir, name));
                delete index.snapshots[name];
                purged += 1;
            }
            return { purged };
        });
    }

    async markChatDeleted(request, body) {
        const identity = await this.resolveOpaque(request, body.opaqueKey);
        const snapshotDir = snapshotDirectory(request);
        return this.inventory.mutate(snapshotDir, (index) => {
            const chat = this.inventory.findIdentityByOpaque(index, identity.canonicalId);
            const deletedAt = new Date().toISOString();
            chat.deletedAt = deletedAt;
            let changed = 0;
            for (const item of snapshotsFor(index, identity.canonicalId, true)) {
                if (item.status === 'pre-restore') continue;
                item.trashedAt ||= deletedAt;
                item.trashReason = 'chat-deleted';
                changed += 1;
            }
            return { opaqueKey: identity.canonicalId, changed };
        });
    }

    async deletionLookup(request, body) {
        const snapshotDir = snapshotDirectory(request);
        const kind = body.kind === 'group' ? 'group' : 'char';
        const chatId = plainFileId(body.chatId, 'chat id');
        return this.inventory.mutate(snapshotDir, (index) =>
            this.inventory.lookupDeletionIdentity(index, kind, chatId));
    }

    async preview(request, body) {
        const identity = await this.resolveOpaque(request, body.opaqueKey);
        const snapshotDir = snapshotDirectory(request);
        return this.inventory.read(snapshotDir, async (index) => {
            const name = path.basename(String(body.name || ''));
            const item = index.snapshots[name];
            if (!item || item.canonicalId !== identity.canonicalId || item.trashedAt) {
                throw new Error('快照不属于目标聊天');
            }
            const text = await fs.promises.readFile(path.join(snapshotDir, name), 'utf8');
            return { name, ...previewFromText(text, body.rounds) };
        });
    }
}

module.exports = {
    SnapshotService,
    contentHash,
    isSuspicious,
    mapLimit,
    publicSnapshot,
    readStableChatFile,
    snapshotName,
    snapshotsFor,
};

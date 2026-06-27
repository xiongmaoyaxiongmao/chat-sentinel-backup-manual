const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const sanitize = require('sanitize-filename');

const info = {
    id: 'chat_sentinel_backup',
    name: 'Chat Sentinel Backup',
    description: 'Writes independent per-chat JSONL snapshots for recovery.',
};

const SNAPSHOT_DIR = 'sentinel-chat';
const DEFAULT_KEEP_PER_CHAT = 80;
const MAX_KEEP_PER_CHAT = 500;
const KEEP_MARK = '_KEEP_';
const lastContentHashByKey = new Map();

function nowStamp() {
    const date = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        '-',
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
    ].join('');
}

function cleanLabel(value) {
    const sanitized = sanitize(String(value || 'chat'))
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');

    return (sanitized || 'chat').slice(0, 80);
}

function keyHashFor(body) {
    const kind = body.isGroup ? 'group' : 'char';
    const raw = [
        kind,
        body.entityId || '',
        body.entityName || '',
        body.chatId || '',
    ].join(':');

    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function keyHashForSource(body, sourceFile) {
    return keyHashFor({
        ...body,
        chatId: path.basename(sourceFile, '.jsonl'),
    });
}

function contentHashFor(jsonl) {
    return crypto.createHash('sha256').update(jsonl).digest('hex');
}

function toJsonl(chat) {
    if (!Array.isArray(chat)) {
        throw new Error('chat must be an array');
    }

    return chat.map((line) => JSON.stringify(line)).join('\n');
}

function getSnapshotDirectory(request) {
    const backupsDir = request.user?.directories?.backups;
    if (!backupsDir) {
        throw new Error('user backups directory is unavailable');
    }

    const snapshotDir = path.join(backupsDir, SNAPSHOT_DIR);
    fs.mkdirSync(snapshotDir, { recursive: true });
    return snapshotDir;
}

function isPathInside(parent, child) {
    const parentPath = path.resolve(parent);
    const childPath = path.resolve(child);
    return childPath === parentPath || childPath.startsWith(`${parentPath}${path.sep}`);
}

function getMessageCount(jsonl) {
    return Math.max(0, jsonl.split('\n').filter((line) => line.trim()).length - 1);
}

function writeSnapshot(snapshotDir, body, jsonl, keyHash) {
    const kind = body.isGroup ? 'group' : 'char';
    const label = cleanLabel(`${body.entityName || kind}_${body.chatId || 'current'}`);
    const messageCount = getMessageCount(jsonl);
    const fileName = `${nowStamp()}_${kind}_${label}_${keyHash}_m${messageCount}.jsonl`;
    const filePath = path.join(snapshotDir, fileName);
    const tempPath = `${filePath}.tmp`;

    fs.writeFileSync(tempPath, jsonl, 'utf8');
    fs.renameSync(tempPath, filePath);

    return {
        file: fileName,
        messageCount,
        bytes: Buffer.byteLength(jsonl, 'utf8'),
    };
}

function isKeptSnapshot(name) {
    return name.includes(KEEP_MARK);
}

function snapshotMessageCountFromName(name) {
    const match = name.match(/_m(\d+)\.jsonl$/);
    return match ? Number(match[1]) : null;
}

function snapshotSummary(filePath) {
    const stat = fs.statSync(filePath);
    const name = path.basename(filePath);
    return {
        name,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        messageCount: snapshotMessageCountFromName(name),
        kept: isKeptSnapshot(name),
    };
}

function snapshotsForKey(snapshotDir, keyHash, limit = 100) {
    if (!fs.existsSync(snapshotDir)) {
        return [];
    }

    return fs.readdirSync(snapshotDir)
        .filter((name) => name.endsWith('.jsonl') && name.includes(`_${keyHash}_`))
        .map((name) => snapshotSummary(path.join(snapshotDir, name)))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, Math.max(1, Math.min(Number(limit) || 100, 500)));
}

function keptSnapshotName(name, keyHash, shouldKeep) {
    if (shouldKeep && !isKeptSnapshot(name)) {
        return name.replace(`_${keyHash}_`, `_${keyHash}${KEEP_MARK}`);
    }
    if (!shouldKeep && isKeptSnapshot(name)) {
        return name.replace(`_${keyHash}${KEEP_MARK}`, `_${keyHash}_`);
    }
    return name;
}

function setSnapshotsKept(snapshotDir, keyHash, names, shouldKeep) {
    const selected = new Set((Array.isArray(names) ? names : []).map((name) => path.basename(String(name))));
    const changes = [];

    for (const name of selected) {
        if (!name.endsWith('.jsonl') || !name.includes(`_${keyHash}_`)) {
            continue;
        }

        const oldPath = path.join(snapshotDir, name);
        if (!fs.existsSync(oldPath) || !isPathInside(snapshotDir, oldPath)) {
            continue;
        }

        const nextName = keptSnapshotName(name, keyHash, shouldKeep);
        if (nextName === name) {
            changes.push({ from: name, to: nextName, unchanged: true });
            continue;
        }

        let nextPath = path.join(snapshotDir, nextName);
        if (fs.existsSync(nextPath)) {
            const parsed = path.parse(nextName);
            nextPath = path.join(snapshotDir, `${parsed.name}_${Date.now()}${parsed.ext}`);
        }

        fs.renameSync(oldPath, nextPath);
        changes.push({ from: name, to: path.basename(nextPath), unchanged: false });
    }

    return changes;
}

function snapshotFiles(snapshotDir, body, chatFiles) {
    const results = [];
    let skipped = 0;

    for (const sourceFile of chatFiles) {
        try {
            const jsonl = fs.readFileSync(sourceFile, 'utf8');
            const messageCount = getMessageCount(jsonl);
            if (messageCount < 1) {
                skipped += 1;
                continue;
            }

            const sourceBody = {
                ...body,
                chatId: path.basename(sourceFile, '.jsonl'),
            };
            const keyHash = keyHashForSource(body, sourceFile);
            const written = writeSnapshot(snapshotDir, sourceBody, jsonl, keyHash);
            trimOldSnapshots(snapshotDir, keyHash, body.keepPerChat);

            results.push({
                source: path.basename(sourceFile),
                keyHash,
                ...written,
            });
        } catch (error) {
            skipped += 1;
            console.warn('[chat-sentinel-backup] skipped chat during bulk snapshot:', sourceFile, error);
        }
    }

    return { results, skipped };
}

function chatFileSummary(filePath) {
    const stat = fs.statSync(filePath);
    const jsonl = fs.readFileSync(filePath, 'utf8');
    return {
        id: path.basename(filePath),
        name: path.basename(filePath, '.jsonl'),
        messageCount: getMessageCount(jsonl),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
    };
}

function getEntityChatFiles(request, body) {
    if (body.isGroup) {
        const groupId = String(body.entityId || '');
        if (!groupId) {
            throw new Error('请先打开一个群聊。');
        }

        let chatIds = Array.isArray(body.groupChatIds) ? body.groupChatIds : [];
        if (chatIds.length === 0) {
            const groupPath = path.join(request.user.directories.groups, sanitize(`${groupId}.json`));
            const groupData = JSON.parse(fs.readFileSync(groupPath, 'utf8'));
            chatIds = Array.isArray(groupData.chats) ? groupData.chats : [];
        }

        return chatIds
            .map((chatId) => path.join(request.user.directories.groupChats, sanitize(`${chatId}.jsonl`)))
            .filter((filePath) => fs.existsSync(filePath) && isPathInside(request.user.directories.groupChats, filePath));
    }

    const avatar = String(body.entityId || '');
    if (!avatar) {
        throw new Error('请先打开一个角色聊天。');
    }

    const chatDir = path.join(request.user.directories.chats, avatar.replace(/\.png$/i, ''));
    if (!isPathInside(request.user.directories.chats, chatDir)) {
        throw new Error('character chat directory is invalid');
    }
    if (!fs.existsSync(chatDir)) {
        return [];
    }

    return fs.readdirSync(chatDir)
        .filter((name) => path.extname(name) === '.jsonl')
        .map((name) => path.join(chatDir, name))
        .filter((filePath) => isPathInside(chatDir, filePath));
}

function trimOldSnapshots(snapshotDir, keyHash, keepPerChat) {
    const limit = Math.max(1, Math.min(Number(keepPerChat) || DEFAULT_KEEP_PER_CHAT, MAX_KEEP_PER_CHAT));
    const files = fs.readdirSync(snapshotDir)
        .filter((name) => name.endsWith('.jsonl') && name.includes(`_${keyHash}_`) && !isKeptSnapshot(name))
        .map((name) => ({
            name,
            path: path.join(snapshotDir, name),
            mtimeMs: fs.statSync(path.join(snapshotDir, name)).mtimeMs,
        }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const file of files.slice(limit)) {
        fs.unlinkSync(file.path);
    }
}

function latestSnapshots(snapshotDir, limit = 20) {
    if (!fs.existsSync(snapshotDir)) {
        return [];
    }

    return fs.readdirSync(snapshotDir)
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => {
            const filePath = path.join(snapshotDir, name);
            const stat = fs.statSync(filePath);
            return {
                name,
                size: stat.size,
                mtimeMs: stat.mtimeMs,
                messageCount: snapshotMessageCountFromName(name),
                kept: isKeptSnapshot(name),
            };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)));
}

async function init(router) {
    router.post('/snapshot', (request, response) => {
        try {
            const body = request.body || {};
            const chat = body.chat;

            if (!Array.isArray(chat) || chat.length < 2) {
                return response.status(400).json({ ok: false, error: 'refusing to snapshot an empty chat' });
            }

            const jsonl = toJsonl(chat);
            const snapshotDir = getSnapshotDirectory(request);
            const keyHash = keyHashFor(body);
            const contentHash = contentHashFor(jsonl);

            if (lastContentHashByKey.get(keyHash) === contentHash) {
                return response.json({
                    ok: true,
                    skipped: true,
                    reason: 'duplicate',
                    keyHash,
                    directory: snapshotDir,
                });
            }

            const written = writeSnapshot(snapshotDir, body, jsonl, keyHash);
            lastContentHashByKey.set(keyHash, contentHash);
            trimOldSnapshots(snapshotDir, keyHash, body.keepPerChat);

            return response.json({
                ok: true,
                skipped: false,
                file: written.file,
                keyHash,
                directory: snapshotDir,
                messageCount: written.messageCount,
                bytes: written.bytes,
            });
        } catch (error) {
            console.error('[chat-sentinel-backup] snapshot failed:', error);
            return response.status(500).json({ ok: false, error: error.message });
        }
    });

    router.post('/entity-chats', (request, response) => {
        try {
            const body = request.body || {};
            const chatFiles = getEntityChatFiles(request, body);
            const chats = chatFiles
                .map((filePath) => chatFileSummary(filePath))
                .sort((a, b) => b.mtimeMs - a.mtimeMs);

            return response.json({
                ok: true,
                total: chats.length,
                chats,
            });
        } catch (error) {
            console.error('[chat-sentinel-backup] entity-chats failed:', error);
            return response.status(500).json({ ok: false, error: error.message });
        }
    });

    router.post('/snapshot-all', (request, response) => {
        try {
            const body = request.body || {};
            const snapshotDir = getSnapshotDirectory(request);
            const chatFiles = getEntityChatFiles(request, body);
            const { results, skipped } = snapshotFiles(snapshotDir, body, chatFiles);

            return response.json({
                ok: true,
                directory: snapshotDir,
                total: chatFiles.length,
                written: results.length,
                skipped,
                snapshots: results,
            });
        } catch (error) {
            console.error('[chat-sentinel-backup] snapshot-all failed:', error);
            return response.status(500).json({ ok: false, error: error.message });
        }
    });

    router.post('/snapshot-selected', (request, response) => {
        try {
            const body = request.body || {};
            const selected = new Set((Array.isArray(body.selected) ? body.selected : []).map((name) => path.basename(String(name))));
            if (selected.size === 0) {
                return response.status(400).json({ ok: false, error: 'no chats selected' });
            }

            const snapshotDir = getSnapshotDirectory(request);
            const allChatFiles = getEntityChatFiles(request, body);
            const chatFiles = allChatFiles.filter((filePath) => selected.has(path.basename(filePath)));
            const { results, skipped } = snapshotFiles(snapshotDir, body, chatFiles);

            return response.json({
                ok: true,
                directory: snapshotDir,
                total: selected.size,
                matched: chatFiles.length,
                written: results.length,
                skipped: skipped + Math.max(0, selected.size - chatFiles.length),
                snapshots: results,
            });
        } catch (error) {
            console.error('[chat-sentinel-backup] snapshot-selected failed:', error);
            return response.status(500).json({ ok: false, error: error.message });
        }
    });

    router.post('/versions', (request, response) => {
        try {
            const body = request.body || {};
            const snapshotDir = getSnapshotDirectory(request);
            const keyHash = keyHashFor(body);
            return response.json({
                ok: true,
                directory: snapshotDir,
                keyHash,
                snapshots: snapshotsForKey(snapshotDir, keyHash, request.body?.limit),
            });
        } catch (error) {
            console.error('[chat-sentinel-backup] versions failed:', error);
            return response.status(500).json({ ok: false, error: error.message });
        }
    });

    router.post('/versions/keep', (request, response) => {
        try {
            const body = request.body || {};
            const snapshotDir = getSnapshotDirectory(request);
            const keyHash = keyHashFor(body);
            const changes = setSnapshotsKept(snapshotDir, keyHash, body.selected, body.keep !== false);
            return response.json({
                ok: true,
                directory: snapshotDir,
                keyHash,
                changed: changes.length,
                changes,
                snapshots: snapshotsForKey(snapshotDir, keyHash, request.body?.limit),
            });
        } catch (error) {
            console.error('[chat-sentinel-backup] versions keep failed:', error);
            return response.status(500).json({ ok: false, error: error.message });
        }
    });

    router.post('/list', (request, response) => {
        try {
            const snapshotDir = getSnapshotDirectory(request);
            return response.json({
                ok: true,
                directory: snapshotDir,
                snapshots: latestSnapshots(snapshotDir, request.body?.limit),
            });
        } catch (error) {
            console.error('[chat-sentinel-backup] list failed:', error);
            return response.status(500).json({ ok: false, error: error.message });
        }
    });
}

module.exports = {
    info,
    init,
};

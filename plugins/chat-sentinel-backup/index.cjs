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
const STATE_FILE = '.sentinel-chat-state.json';
const DEFAULT_KEEP_PER_CHAT = 80;
const MAX_KEEP_PER_CHAT = 500;
const KEEP_MARK = '_KEEP_';
const STABLE_READ_ATTEMPTS = 5;
const STABLE_READ_DELAY_MS = 150;
const REGRESSION_MIN_BASELINE = 20;
const REGRESSION_MIN_DROP = 20;
const REGRESSION_MAX_RATIO = 0.25;
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

function writeSnapshot(snapshotDir, body, jsonl, keyHash, knownMessageCount = null) {
    const kind = body.isGroup ? 'group' : 'char';
    const label = cleanLabel(`${body.entityName || kind}_${body.chatId || 'current'}`);
    const messageCount = Number.isInteger(knownMessageCount) ? knownMessageCount : getMessageCount(jsonl);
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

function snapshotKeyHashFromName(name) {
    const match = String(name || '').match(/_([a-f0-9]{16})(?:_KEEP)?_m\d+\.jsonl$/);
    return match ? match[1] : '';
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

function statePath(snapshotDir) {
    return path.join(snapshotDir, STATE_FILE);
}

function emptyState() {
    return {
        version: 1,
        deleted: {},
    };
}

function readState(snapshotDir) {
    const filePath = statePath(snapshotDir);
    if (!fs.existsSync(filePath)) {
        return emptyState();
    }

    try {
        const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return {
            version: 1,
            deleted: state && typeof state.deleted === 'object' && state.deleted ? state.deleted : {},
        };
    } catch (error) {
        console.warn('[chat-sentinel-backup] failed to read state file:', error.message);
        return emptyState();
    }
}

function writeState(snapshotDir, state) {
    const filePath = statePath(snapshotDir);
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, filePath);
}

function clearDeletedKey(snapshotDir, keyHash) {
    const state = readState(snapshotDir);
    if (!state.deleted[keyHash]) {
        return false;
    }

    delete state.deleted[keyHash];
    writeState(snapshotDir, state);
    return true;
}

function markDeleted(snapshotDir, body) {
    const keyHash = keyHashFor(body);
    const state = readState(snapshotDir);
    const existing = state.deleted[keyHash] || {};
    state.deleted[keyHash] = {
        ...existing,
        keyHash,
        isGroup: Boolean(body.isGroup),
        entityId: String(body.entityId || ''),
        entityName: String(body.entityName || ''),
        chatId: String(body.chatId || ''),
        deletedAt: new Date().toISOString(),
    };
    writeState(snapshotDir, state);
    return state.deleted[keyHash];
}

function deletedKeys(snapshotDir) {
    return new Set(Object.keys(readState(snapshotDir).deleted));
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

function snapshotPathForKey(snapshotDir, keyHash, name) {
    const safeName = path.basename(String(name || ''));
    if (!safeName.endsWith('.jsonl') || !safeName.includes(`_${keyHash}_`)) {
        throw new Error('snapshot does not belong to the current chat');
    }

    const filePath = path.join(snapshotDir, safeName);
    if (!isPathInside(snapshotDir, filePath) || !fs.existsSync(filePath)) {
        throw new Error('snapshot was not found');
    }

    return filePath;
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

function deleteSnapshots(snapshotDir, keyHash, names) {
    const selected = new Set((Array.isArray(names) ? names : []).map((name) => path.basename(String(name))));
    let deleted = 0;

    for (const name of selected) {
        try {
            const filePath = snapshotPathForKey(snapshotDir, keyHash, name);
            fs.unlinkSync(filePath);
            deleted += 1;
        } catch (error) {
            console.warn('[chat-sentinel-backup] skipped snapshot delete:', name, error.message);
        }
    }

    return deleted;
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
            clearDeletedKey(snapshotDir, keyHash);
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

function withJsonlExtension(name) {
    const baseName = path.basename(String(name || ''));
    if (!baseName) {
        throw new Error('当前没有可覆盖的聊天文件。');
    }

    return baseName.endsWith('.jsonl') ? baseName : `${baseName}.jsonl`;
}

function getActiveChatFilePath(request, body) {
    const chatId = withJsonlExtension(body.chatId);

    if (body.isGroup) {
        const groupChatsDir = request.user?.directories?.groupChats;
        if (!groupChatsDir) {
            throw new Error('group chats directory is unavailable');
        }

        const targetPath = path.join(groupChatsDir, sanitize(chatId));
        if (!isPathInside(groupChatsDir, targetPath)) {
            throw new Error('group chat file is invalid');
        }

        return targetPath;
    }

    const avatar = String(body.entityId || '');
    if (!avatar) {
        throw new Error('请先打开一个角色聊天。');
    }

    const chatsDir = request.user?.directories?.chats;
    if (!chatsDir) {
        throw new Error('character chats directory is unavailable');
    }

    const chatDir = path.join(chatsDir, avatar.replace(/\.png$/i, ''));
    if (!isPathInside(chatsDir, chatDir)) {
        throw new Error('character chat directory is invalid');
    }

    fs.mkdirSync(chatDir, { recursive: true });
    const targetPath = path.join(chatDir, sanitize(chatId));
    if (!isPathInside(chatDir, targetPath)) {
        throw new Error('chat file is invalid');
    }

    return targetPath;
}

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readStableChatFile(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error('当前聊天尚未保存到服务器。');
    }

    for (let attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt += 1) {
        const before = await fs.promises.stat(filePath);
        const jsonl = await fs.promises.readFile(filePath, 'utf8');
        const after = await fs.promises.stat(filePath);

        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
            await sleep(STABLE_READ_DELAY_MS);
            continue;
        }

        const lines = jsonl.split('\n').filter((line) => line.trim());
        if (lines.length < 2) {
            throw new Error('当前聊天文件没有可备份的消息。');
        }

        try {
            JSON.parse(lines[0]);
            JSON.parse(lines[lines.length - 1]);
        } catch {
            throw new Error('当前聊天文件尚未完整写入，请稍后重试。');
        }

        return {
            jsonl,
            messageCount: lines.length - 1,
            size: after.size,
            mtimeMs: after.mtimeMs,
        };
    }

    throw new Error('当前聊天文件仍在写入，请稍后重试。');
}

function highestSnapshotMessageCount(snapshotDir, keyHash) {
    if (!fs.existsSync(snapshotDir)) {
        return 0;
    }

    return fs.readdirSync(snapshotDir)
        .filter((name) => name.endsWith('.jsonl') && name.includes(`_${keyHash}_`))
        .map((name) => snapshotMessageCountFromName(name))
        .filter(Number.isInteger)
        .reduce((highest, count) => Math.max(highest, count), 0);
}

function isSuspiciousMessageRegression(currentCount, baselineCount) {
    return baselineCount >= REGRESSION_MIN_BASELINE
        && baselineCount - currentCount >= REGRESSION_MIN_DROP
        && currentCount <= Math.floor(baselineCount * REGRESSION_MAX_RATIO);
}

function registerRestoredGroupChat(request, body) {
    if (!body.isGroup) {
        return;
    }

    const groupId = String(body.entityId || '');
    const chatId = String(body.chatId || '');
    if (!groupId || !chatId) {
        return;
    }

    const groupPath = path.join(request.user.directories.groups, sanitize(`${groupId}.json`));
    if (!isPathInside(request.user.directories.groups, groupPath) || !fs.existsSync(groupPath)) {
        return;
    }

    const groupData = JSON.parse(fs.readFileSync(groupPath, 'utf8'));
    if (!Array.isArray(groupData.chats)) {
        groupData.chats = [];
    }
    if (!groupData.chats.includes(chatId)) {
        groupData.chats.push(chatId);
    }
    if (!groupData.chat_id) {
        groupData.chat_id = chatId;
    }

    const tempPath = `${groupPath}.sentinel-restore-${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(groupData, null, 4), 'utf8');
    fs.renameSync(tempPath, groupPath);
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

function latestSnapshots(snapshotDir, limit = 20, includeDeleted = false) {
    if (!fs.existsSync(snapshotDir)) {
        return [];
    }

    const hiddenKeys = includeDeleted ? new Set() : deletedKeys(snapshotDir);
    return fs.readdirSync(snapshotDir)
        .filter((name) => name.endsWith('.jsonl') && !hiddenKeys.has(snapshotKeyHashFromName(name)))
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

function deletedSnapshotGroups(snapshotDir, limit = 100) {
    if (!fs.existsSync(snapshotDir)) {
        return [];
    }

    const state = readState(snapshotDir);
    return Object.values(state.deleted)
        .map((record) => {
            const snapshots = snapshotsForKey(snapshotDir, record.keyHash, 500);
            if (snapshots.length === 0) {
                return null;
            }

            return {
                ...record,
                snapshotCount: snapshots.length,
                latest: snapshots[0],
            };
        })
        .filter(Boolean)
        .sort((a, b) => (b.latest?.mtimeMs || 0) - (a.latest?.mtimeMs || 0))
        .slice(0, Math.max(1, Math.min(Number(limit) || 100, 500)));
}

function deleteDeletedSnapshotGroups(snapshotDir, keyHashes) {
    const selected = new Set((Array.isArray(keyHashes) ? keyHashes : []).map((keyHash) => String(keyHash || '')));
    const state = readState(snapshotDir);
    let deletedFiles = 0;
    let deletedChats = 0;

    for (const keyHash of selected) {
        if (!/^[a-f0-9]{16}$/.test(keyHash) || !state.deleted[keyHash]) {
            continue;
        }

        while (true) {
            const snapshots = snapshotsForKey(snapshotDir, keyHash, 500);
            if (snapshots.length === 0) {
                break;
            }

            for (const snapshot of snapshots) {
                try {
                    fs.unlinkSync(snapshotPathForKey(snapshotDir, keyHash, snapshot.name));
                    deletedFiles += 1;
                } catch (error) {
                    console.warn('[chat-sentinel-backup] skipped deleted snapshot purge:', snapshot.name, error.message);
                }
            }
        }

        delete state.deleted[keyHash];
        deletedChats += 1;
    }

    writeState(snapshotDir, state);
    return { deletedChats, deletedFiles };
}

function restoreDeletedSnapshotGroup(request, snapshotDir, keyHash) {
    if (!/^[a-f0-9]{16}$/.test(keyHash)) {
        throw new Error('deleted chat key is invalid');
    }

    const state = readState(snapshotDir);
    const record = state.deleted[keyHash];
    if (!record) {
        throw new Error('deleted chat was not found');
    }

    const snapshots = snapshotsForKey(snapshotDir, keyHash, 1);
    if (snapshots.length === 0) {
        delete state.deleted[keyHash];
        writeState(snapshotDir, state);
        throw new Error('deleted chat has no snapshots left');
    }

    const sourcePath = snapshotPathForKey(snapshotDir, keyHash, snapshots[0].name);
    const targetPath = getActiveChatFilePath(request, record);
    const tempPath = `${targetPath}.sentinel-restore-${Date.now()}.tmp`;

    fs.copyFileSync(sourcePath, tempPath);
    fs.renameSync(tempPath, targetPath);
    registerRestoredGroupChat(request, record);

    delete state.deleted[keyHash];
    writeState(snapshotDir, state);

    return {
        restored: path.basename(sourcePath),
        target: path.basename(targetPath),
        chatId: record.chatId,
    };
}

function readJsonlObjects(filePath) {
    return fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
}

function previewSnapshot(filePath, rounds = 2) {
    const objects = readJsonlObjects(filePath);
    const messages = objects
        .slice(1)
        .filter((item) => item && typeof item === 'object' && ('mes' in item || 'name' in item));
    const limit = Math.max(2, Math.min((Number(rounds) || 2) * 2, 12));

    return {
        name: path.basename(filePath),
        messageCount: messages.length,
        messages: messages.slice(-limit).map((message) => ({
            name: String(message.name || (message.is_user ? 'User' : 'Assistant')),
            is_user: Boolean(message.is_user),
            send_date: message.send_date || message.send_date_full || '',
            mes: String(message.mes || '').slice(0, 2000),
        })),
    };
}

async function init(router) {
    router.post('/snapshot', async (request, response) => {
        try {
            const body = request.body || {};
            const sourcePath = getActiveChatFilePath(request, body);
            const source = await readStableChatFile(sourcePath);
            const snapshotDir = getSnapshotDirectory(request);
            const keyHash = keyHashFor(body);
            const baselineMessageCount = highestSnapshotMessageCount(snapshotDir, keyHash);

            if (isSuspiciousMessageRegression(source.messageCount, baselineMessageCount)) {
                return response.status(409).json({
                    ok: false,
                    code: 'message_count_regression',
                    error: `检测到当前聊天从 ${baselineMessageCount} 条骤降到 ${source.messageCount} 条，已拒绝写入可疑快照。`,
                    currentMessageCount: source.messageCount,
                    baselineMessageCount,
                });
            }

            const contentHash = contentHashFor(source.jsonl);

            if (lastContentHashByKey.get(keyHash) === contentHash) {
                clearDeletedKey(snapshotDir, keyHash);
                return response.json({
                    ok: true,
                    skipped: true,
                    reason: 'duplicate',
                    keyHash,
                    directory: snapshotDir,
                });
            }

            const written = writeSnapshot(snapshotDir, body, source.jsonl, keyHash, source.messageCount);
            clearDeletedKey(snapshotDir, keyHash);
            lastContentHashByKey.set(keyHash, contentHash);
            trimOldSnapshots(snapshotDir, keyHash, body.keepPerChat);

            return response.json({
                ok: true,
                skipped: false,
                file: written.file,
                keyHash,
                directory: snapshotDir,
                source: path.basename(sourcePath),
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

    router.post('/versions/delete', (request, response) => {
        try {
            const body = request.body || {};
            const snapshotDir = getSnapshotDirectory(request);
            const keyHash = keyHashFor(body);
            const deleted = deleteSnapshots(snapshotDir, keyHash, body.selected);
            return response.json({
                ok: true,
                directory: snapshotDir,
                keyHash,
                deleted,
                snapshots: snapshotsForKey(snapshotDir, keyHash, request.body?.limit),
            });
        } catch (error) {
            console.error('[chat-sentinel-backup] versions delete failed:', error);
            return response.status(500).json({ ok: false, error: error.message });
        }
    });

    router.post('/versions/preview', (request, response) => {
        try {
            const body = request.body || {};
            const snapshotDir = getSnapshotDirectory(request);
            const keyHash = keyHashFor(body);
            const filePath = snapshotPathForKey(snapshotDir, keyHash, body.name);
            return response.json({
                ok: true,
                ...previewSnapshot(filePath, body.rounds),
            });
        } catch (error) {
            console.error('[chat-sentinel-backup] versions preview failed:', error);
            return response.status(500).json({ ok: false, error: error.message });
        }
    });

    router.post('/versions/restore', (request, response) => {
        try {
            const body = request.body || {};
            const snapshotDir = getSnapshotDirectory(request);
            const keyHash = keyHashFor(body);
            const sourcePath = snapshotPathForKey(snapshotDir, keyHash, body.name);
            const targetPath = getActiveChatFilePath(request, body);
            const tempPath = `${targetPath}.sentinel-restore-${Date.now()}.tmp`;

            fs.copyFileSync(sourcePath, tempPath);
            fs.renameSync(tempPath, targetPath);
            clearDeletedKey(snapshotDir, keyHash);

            return response.json({
                ok: true,
                restored: path.basename(sourcePath),
                target: path.basename(targetPath),
            });
        } catch (error) {
            console.error('[chat-sentinel-backup] versions restore failed:', error);
            return response.status(500).json({ ok: false, error: error.message });
        }
    });

    router.post('/deleted/mark', (request, response) => {
        try {
            const body = request.body || {};
            if (!body.chatId) {
                return response.status(400).json({ ok: false, error: 'deleted chat id is required' });
            }

            const snapshotDir = getSnapshotDirectory(request);
            const record = markDeleted(snapshotDir, body);
            return response.json({
                ok: true,
                directory: snapshotDir,
                deleted: record,
            });
        } catch (error) {
            console.error('[chat-sentinel-backup] deleted mark failed:', error);
            return response.status(500).json({ ok: false, error: error.message });
        }
    });

    router.post('/deleted/list', (request, response) => {
        try {
            const snapshotDir = getSnapshotDirectory(request);
            const chats = deletedSnapshotGroups(snapshotDir, request.body?.limit);
            return response.json({
                ok: true,
                directory: snapshotDir,
                total: chats.length,
                chats,
            });
        } catch (error) {
            console.error('[chat-sentinel-backup] deleted list failed:', error);
            return response.status(500).json({ ok: false, error: error.message });
        }
    });

    router.post('/deleted/restore', (request, response) => {
        try {
            const body = request.body || {};
            const snapshotDir = getSnapshotDirectory(request);
            const restored = restoreDeletedSnapshotGroup(request, snapshotDir, String(body.keyHash || ''));
            return response.json({
                ok: true,
                ...restored,
                chats: deletedSnapshotGroups(snapshotDir, request.body?.limit),
            });
        } catch (error) {
            console.error('[chat-sentinel-backup] deleted restore failed:', error);
            return response.status(500).json({ ok: false, error: error.message });
        }
    });

    router.post('/deleted/purge', (request, response) => {
        try {
            const body = request.body || {};
            const snapshotDir = getSnapshotDirectory(request);
            const result = deleteDeletedSnapshotGroups(snapshotDir, body.selected);
            return response.json({
                ok: true,
                directory: snapshotDir,
                ...result,
                chats: deletedSnapshotGroups(snapshotDir, request.body?.limit),
            });
        } catch (error) {
            console.error('[chat-sentinel-backup] deleted purge failed:', error);
            return response.status(500).json({ ok: false, error: error.message });
        }
    });

    router.post('/list', (request, response) => {
        try {
            const snapshotDir = getSnapshotDirectory(request);
            return response.json({
                ok: true,
                directory: snapshotDir,
                snapshots: latestSnapshots(snapshotDir, request.body?.limit, Boolean(request.body?.includeDeleted)),
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

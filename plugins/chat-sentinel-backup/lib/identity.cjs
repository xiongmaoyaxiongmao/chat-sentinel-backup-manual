const path = require('node:path');
const crypto = require('node:crypto');

function hash(value, length = 24) {
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function cleanLabel(value) {
    return String(value || 'chat')
        .normalize('NFKC')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^[-_.]+|[-_.]+$/g, '')
        .slice(0, 72) || 'chat';
}

function isPathInside(parent, child) {
    const root = path.resolve(parent);
    const candidate = path.resolve(child);
    return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function plainFileId(value, label) {
    const text = String(value || '').replace(/\.jsonl$/i, '');
    if (!text || text !== path.basename(text) || text.includes('\0') || text === '.' || text === '..') {
        throw new Error(`${label} is invalid`);
    }
    return text;
}

function stableEntityId(body) {
    const value = plainFileId(body.entityId, body.isGroup ? 'group id' : 'character id');
    return body.isGroup ? value : value.replace(/\.png$/i, '');
}

function userDirectories(request) {
    const directories = request.user?.directories;
    if (!directories?.backups || !directories?.chats || !directories?.groupChats) {
        throw new Error('user directories are unavailable');
    }
    return directories;
}

function resolveChatIdentity(request, body) {
    const directories = userDirectories(request);
    const kind = body.isGroup ? 'group' : 'char';
    const entityId = stableEntityId(body);
    const chatId = plainFileId(body.chatId, 'chat id');
    const fileName = `${chatId}.jsonl`;
    const entityRoot = body.isGroup
        ? directories.groupChats
        : path.join(directories.chats, entityId);
    const targetPath = path.join(entityRoot, fileName);

    if (!isPathInside(body.isGroup ? directories.groupChats : directories.chats, entityRoot)
        || !isPathInside(entityRoot, targetPath)) {
        throw new Error('chat path is outside the current user scope');
    }

    const userScope = hash(path.resolve(directories.backups), 20);
    const pathSemantic = body.isGroup
        ? `groupChats/${fileName}`
        : `chats/${entityId}/${fileName}`;
    const canonicalId = hash(`${userScope}\0${kind}\0${entityId}\0${pathSemantic}`, 24);
    const legacyId = hash([
        kind,
        String(body.entityId || ''),
        String(body.entityName || ''),
        chatId,
    ].join(':'), 16);

    return {
        canonicalId,
        legacyId,
        userScope,
        kind,
        isGroup: body.isGroup === true,
        entityId,
        entityName: String(body.entityName || (body.isGroup ? '群聊' : '角色')),
        chatId,
        pathSemantic,
        targetPath,
        entityRoot,
        label: cleanLabel(`${body.entityName || kind}_${chatId}`),
    };
}

function identityFromRecord(request, record) {
    if (!record || !/^[a-f0-9]{24}$/.test(String(record.canonicalId || ''))
        || !record.entityId || !record.chatId || !['char', 'group'].includes(record.kind)) {
        throw new Error('stored chat identity is incomplete');
    }
    const identity = resolveChatIdentity(request, {
        isGroup: record.kind === 'group',
        entityId: record.entityId,
        entityName: record.entityName,
        chatId: record.chatId,
    });
    if (record.pathSemantic !== identity.pathSemantic) {
        const error = new Error('stored chat target is incomplete');
        error.statusCode = 409;
        error.code = 'canonical_target_ambiguous';
        throw error;
    }
    // A canonical ID is allocated on first successful registration.  The
    // record's current target may later be remapped after a host rename, so
    // never derive the stable opaque key from mutable path coordinates again.
    return { ...identity, canonicalId: record.canonicalId };
}

function snapshotDirectory(request) {
    const directories = userDirectories(request);
    const result = path.join(directories.backups, 'sentinel-chat');
    if (!isPathInside(directories.backups, result)) {
        throw new Error('snapshot directory is outside the current user scope');
    }
    return result;
}

module.exports = {
    cleanLabel,
    hash,
    identityFromRecord,
    isPathInside,
    plainFileId,
    resolveChatIdentity,
    snapshotDirectory,
    stableEntityId,
    userDirectories,
};

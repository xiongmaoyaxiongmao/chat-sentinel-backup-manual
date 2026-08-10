const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { identityFromRecord, plainFileId } = require('./identity.cjs');
const { KeyedTaskQueue } = require('./task-queue.cjs');

const INDEX_FILE = '.sentinel-chat-index.v2.json';
const LEGACY_STATE_FILE = '.sentinel-chat-state.json';
const TRANSACTION_DIR = '.sentinel-transactions';

function clone(value) {
    return structuredClone(value);
}

function emptyHealth() {
    return {
        degraded: false,
        destructiveBlocked: false,
        issues: [],
        lastWriteFailure: null,
        lastCleanupFailure: null,
        repairConfirmedAt: null,
    };
}

function emptyIndex() {
    return {
        version: 2,
        migratedAt: new Date().toISOString(),
        chats: {},
        snapshots: {},
        quarantine: {},
        review: {},
        health: emptyHealth(),
    };
}

function normalizeIndex(value) {
    if (!value || value.version !== 2 || typeof value.chats !== 'object' || typeof value.snapshots !== 'object') {
        throw new Error('unsupported index');
    }
    value.quarantine ||= {};
    value.review ||= {};
    value.rolling ||= { version: 1, chats: {} };
    value.rolling.chats ||= {};
    value.health = {
        ...emptyHealth(),
        ...(value.health || {}),
        issues: Array.isArray(value.health?.issues) ? value.health.issues : [],
    };
    return value;
}

function parseV2Name(name) {
    const match = String(name).match(
        /^(\d{8}T\d{9}Z)__(char|group)__(.*?)__c([a-f0-9]{24})__u([a-f0-9]{12,32})__m(\d+)__(auto|manual|confirmed|pre-restore)\.jsonl$/,
    );
    if (!match) return null;
    return {
        createdStamp: match[1],
        kind: match[2],
        label: match[3],
        canonicalId: match[4],
        uniqueId: match[5],
        messageCount: Number(match[6]),
        status: match[7],
    };
}

function parseLegacyName(name) {
    const match = String(name).match(
        /^(\d{8}-\d{6})_(char|group)_(.*?)_([a-f0-9]{16})(?:_(KEEP))?_m(\d+)(?:_\d+)?\.jsonl$/,
    );
    if (!match) return null;
    return {
        createdStamp: match[1],
        kind: match[2],
        label: match[3],
        legacyId: match[4],
        kept: Boolean(match[5]),
        messageCount: Number(match[6]),
        status: 'legacy',
    };
}

async function fsyncDirectory(directory, fsApi = fs.promises) {
    let handle;
    try {
        handle = await fsApi.open(directory, 'r');
        await handle.sync();
    } catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error;
    } finally {
        await handle?.close();
    }
}

async function atomicWriteText(filePath, text, fsApi = fs.promises) {
    const temp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    let handle;
    try {
        handle = await fsApi.open(temp, 'wx', 0o600);
        await handle.writeFile(text, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await fsApi.rename(temp, filePath);
        await fsyncDirectory(path.dirname(filePath), fsApi);
    } catch (error) {
        await handle?.close().catch(() => {});
        await fsApi.unlink(temp).catch(() => {});
        throw error;
    }
}

async function atomicWriteJson(filePath, value, fsApi = fs.promises) {
    await atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`, fsApi);
}

function issueKey(issue) {
    return `${issue.code}:${issue.file || ''}:${issue.reviewId || ''}:${issue.quarantinedAs || ''}`;
}

function addIssue(index, issue) {
    const normalized = { at: new Date().toISOString(), ...issue };
    const key = issueKey(normalized);
    const existing = index.health.issues.findIndex((item) => issueKey(item) === key);
    if (existing >= 0) index.health.issues[existing] = normalized;
    else index.health.issues.push(normalized);
}

function sameCurrentTarget(chat, identity) {
    return !chat.legacy
        && chat.kind === identity.kind
        && chat.entityId === identity.entityId
        && chat.chatId === identity.chatId
        && chat.pathSemantic === identity.pathSemantic;
}

function canonicalTargetAmbiguous(message = 'current canonical target is ambiguous') {
    const error = new Error(message);
    error.statusCode = 409;
    error.code = 'canonical_target_ambiguous';
    return error;
}

function currentTargetRecords(index, identity) {
    return Object.values(index.chats).filter((chat) => sameCurrentTarget(chat, identity));
}

function allocateCanonicalId(index, preferred) {
    if (!index.chats[preferred]) return preferred;
    let canonicalId;
    do {
        canonicalId = crypto.randomBytes(12).toString('hex');
    } while (index.chats[canonicalId]);
    return canonicalId;
}

function removeDerivedIssues(index) {
    const derived = new Set(['quarantine_items', 'pending_review']);
    index.health.issues = index.health.issues.filter((issue) => !derived.has(issue.code));
}

function refreshHealth(index, runtimeIssues = []) {
    removeDerivedIssues(index);
    const quarantineCount = Object.keys(index.quarantine).length;
    const reviewCount = Object.keys(index.review).length;
    if (quarantineCount) addIssue(index, { code: 'quarantine_items', count: quarantineCount });
    if (reviewCount) addIssue(index, { code: 'pending_review', count: reviewCount });
    for (const issue of runtimeIssues) addIssue(index, issue);
    const writeFailure = [...index.health.issues].reverse().find((issue) =>
        ['index_write_failed', 'index_rebuild_write_failed', 'index_audit_write_failed', 'health_write_failed']
            .includes(issue.code));
    if (writeFailure) {
        index.health.lastWriteFailure = { at: writeFailure.at, message: writeFailure.message };
    }
    index.health.degraded = index.health.issues.length > 0;
    const confirmable = new Set(['index_corrupt', 'quarantine_items']);
    const nonBlocking = new Set(['pending_review']);
    index.health.destructiveBlocked = index.health.issues.some((issue) => {
        if (nonBlocking.has(issue.code)) return false;
        if (index.health.repairConfirmedAt && confirmable.has(issue.code)) return false;
        return true;
    });
    return index.health;
}

async function readLegacyDeleted(snapshotDir, fsApi = fs.promises) {
    try {
        const raw = await fsApi.readFile(path.join(snapshotDir, LEGACY_STATE_FILE), 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed.deleted === 'object' ? parsed.deleted : {};
    } catch {
        return {};
    }
}

function quarantineRecord(name, stat, parsed, legacy, reason, deletedEvidence = null) {
    return {
        id: `file:${name}`,
        name,
        reason,
        kind: parsed?.kind || legacy?.kind || 'unknown',
        label: parsed?.label || legacy?.label || name,
        canonicalHint: parsed?.canonicalId || '',
        legacyId: legacy?.legacyId || '',
        messageCount: parsed?.messageCount ?? legacy?.messageCount ?? null,
        status: parsed?.status || legacy?.status || 'unknown',
        reliableKept: legacy ? legacy.kept : null,
        deletedEvidence,
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        discoveredAt: new Date().toISOString(),
    };
}

async function scanExisting(snapshotDir, fsApi = fs.promises, reason = 'initial_inventory') {
    const index = emptyIndex();
    const deleted = await readLegacyDeleted(snapshotDir, fsApi);
    const names = await fsApi.readdir(snapshotDir);
    for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const parsed = parseV2Name(name);
        const legacy = parsed ? null : parseLegacyName(name);
        const stat = await fsApi.stat(path.join(snapshotDir, name));
        const recordReason = parsed ? 'unindexed_v2' : legacy ? 'legacy_identity_unproven' : 'unparseable_snapshot_name';
        index.quarantine[`file:${name}`] = quarantineRecord(
            name,
            stat,
            parsed,
            legacy,
            reason === 'corrupt_index_rebuild' ? `corrupt_rebuild_${recordReason}` : recordReason,
            legacy ? deleted[legacy.legacyId] || null : null,
        );
    }
    refreshHealth(index);
    return index;
}

async function inspectDisk(index, snapshotDir, fsApi = fs.promises) {
    const names = await fsApi.readdir(snapshotDir);
    const jsonl = new Set(names.filter((name) => name.endsWith('.jsonl')));
    const tracked = new Set([
        ...Object.keys(index.snapshots),
        ...Object.values(index.quarantine).map((item) => item.name),
        ...Object.values(index.rolling?.chats || {}).flatMap((chat) =>
            (Array.isArray(chat.slots) ? chat.slots : []).map((item) => item.name)),
    ]);
    let changed = false;

    for (const name of jsonl) {
        if (tracked.has(name)) continue;
        const parsed = parseV2Name(name);
        const legacy = parsed ? null : parseLegacyName(name);
        const stat = await fsApi.stat(path.join(snapshotDir, name));
        index.quarantine[`file:${name}`] = quarantineRecord(
            name,
            stat,
            parsed,
            legacy,
            parsed ? 'unindexed_v2' : legacy ? 'legacy_identity_unproven' : 'unparseable_snapshot_name',
        );
        changed = true;
    }

    const missing = Object.keys(index.snapshots).filter((name) => !jsonl.has(name));
    index.health.issues = index.health.issues.filter((issue) => issue.code !== 'missing_snapshot_files');
    if (missing.length) {
        addIssue(index, { code: 'missing_snapshot_files', count: missing.length, files: missing.slice(0, 20) });
        changed = true;
    }

    const txPath = path.join(snapshotDir, TRANSACTION_DIR);
    let remnants = [];
    try {
        remnants = await fsApi.readdir(txPath);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    index.health.issues = index.health.issues.filter((issue) => issue.code !== 'transaction_remnants');
    if (remnants.length) {
        addIssue(index, { code: 'transaction_remnants', count: remnants.length });
        changed = true;
    }
    refreshHealth(index);
    return changed;
}

class FileTransaction {
    constructor(snapshotDir, fsApi = fs.promises) {
        this.snapshotDir = snapshotDir;
        this.fs = fsApi;
        this.id = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
        this.stageRoot = path.join(snapshotDir, TRANSACTION_DIR, this.id);
        this.actions = [];
        this.started = false;
    }

    async start() {
        if (this.started) return;
        await this.fs.mkdir(this.stageRoot, { recursive: true });
        this.started = true;
    }

    async exists(filePath) {
        try {
            await this.fs.stat(filePath);
            return true;
        } catch (error) {
            if (error.code === 'ENOENT') return false;
            throw error;
        }
    }

    async stageCreate(filePath, text) {
        await this.start();
        if (await this.exists(filePath)) throw new Error(`refusing to replace existing file: ${path.basename(filePath)}`);
        await atomicWriteText(filePath, text, this.fs);
        this.actions.push({ type: 'create', filePath });
    }

    async stageDelete(filePath) {
        await this.start();
        if (!await this.exists(filePath)) return false;
        const staged = path.join(this.stageRoot, `${this.actions.length}-${path.basename(filePath)}`);
        await this.fs.rename(filePath, staged);
        this.actions.push({ type: 'delete', filePath, staged });
        return true;
    }

    async stageReplace(filePath, text) {
        await this.start();
        const hadOriginal = await this.exists(filePath);
        const backup = `${filePath}.sentinel-tx-${this.id}.bak`;
        const action = {
            type: 'replace',
            filePath,
            backup,
            hadOriginal,
            originalMoved: false,
        };
        this.actions.push(action);
        if (hadOriginal) {
            await this.fs.rename(filePath, backup);
            action.originalMoved = true;
        }
        await atomicWriteText(filePath, text, this.fs);
    }

    async rollback() {
        const failures = [];
        for (const action of [...this.actions].reverse()) {
            try {
                if (action.type === 'create') {
                    await this.fs.unlink(action.filePath).catch((error) => {
                        if (error.code !== 'ENOENT') throw error;
                    });
                } else if (action.type === 'delete') {
                    await this.fs.rename(action.staged, action.filePath);
                } else if (action.type === 'replace') {
                    if (action.hadOriginal && !action.originalMoved) continue;
                    await this.fs.unlink(action.filePath).catch((error) => {
                        if (error.code !== 'ENOENT') throw error;
                    });
                    if (action.hadOriginal) {
                        await this.fs.rename(action.backup, action.filePath);
                        const [targetExists, backupExists] = await Promise.all([
                            this.exists(action.filePath),
                            this.exists(action.backup),
                        ]);
                        if (!targetExists || backupExists) {
                            throw new Error(`replace rollback verification failed: ${path.basename(action.filePath)}`);
                        }
                    } else if (await this.exists(action.filePath)) {
                        throw new Error(`replace rollback left a new file behind: ${path.basename(action.filePath)}`);
                    }
                }
            } catch (error) {
                failures.push(error);
            }
        }
        if (failures.length) throw new AggregateError(failures, 'file transaction rollback failed');
        await this.removeStageRoot();
    }

    async finalize() {
        const failures = [];
        for (const action of this.actions) {
            try {
                if (action.type === 'delete') await this.fs.unlink(action.staged);
                if (action.type === 'replace' && action.hadOriginal) await this.fs.unlink(action.backup);
            } catch (error) {
                failures.push(error);
            }
        }
        await this.removeStageRoot();
        if (failures.length) throw new AggregateError(failures, 'file transaction cleanup failed');
    }

    async removeStageRoot() {
        if (!this.started) return;
        await this.fs.rmdir(this.stageRoot).catch((error) => {
            if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
        });
        await this.fs.rmdir(path.dirname(this.stageRoot)).catch((error) => {
            if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
        });
    }
}

class InventoryOwner {
    constructor(options = {}) {
        this.fs = options.fs || fs.promises;
        this.atomicWrite = options.atomicWrite || ((filePath, value) => atomicWriteJson(filePath, value, this.fs));
        this.cache = new Map();
        this.runtimeIssues = new Map();
        this.queue = new KeyedTaskQueue();
    }

    runtimeFor(snapshotDir) {
        if (!this.runtimeIssues.has(snapshotDir)) this.runtimeIssues.set(snapshotDir, []);
        return this.runtimeIssues.get(snapshotDir);
    }

    recordRuntimeIssue(snapshotDir, issue) {
        const issues = this.runtimeFor(snapshotDir);
        const normalized = { at: new Date().toISOString(), ...issue };
        const key = issueKey(normalized);
        const existing = issues.findIndex((item) => issueKey(item) === key);
        if (existing >= 0) issues[existing] = normalized;
        else issues.push(normalized);
    }

    async load(snapshotDir) {
        if (this.cache.has(snapshotDir)) return this.cache.get(snapshotDir);
        await this.fs.mkdir(snapshotDir, { recursive: true });
        const filePath = path.join(snapshotDir, INDEX_FILE);
        let index;
        let raw;
        try {
            raw = await this.fs.readFile(filePath, 'utf8');
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }

        if (raw === undefined) {
            index = await scanExisting(snapshotDir, this.fs);
            await this.atomicWrite(filePath, index);
        } else {
            try {
                index = normalizeIndex(JSON.parse(raw));
            } catch (error) {
                const quarantinedAs = `${INDEX_FILE}.corrupt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
                const corruptPath = path.join(snapshotDir, quarantinedAs);
                await this.fs.rename(filePath, corruptPath);
                await fsyncDirectory(snapshotDir, this.fs);
                index = await scanExisting(snapshotDir, this.fs, 'corrupt_index_rebuild');
                addIssue(index, {
                    code: 'index_corrupt',
                    quarantinedAs,
                    message: error.message,
                    requiresUserConfirmation: true,
                });
                refreshHealth(index);
                try {
                    await this.atomicWrite(filePath, index);
                } catch (writeError) {
                    await this.fs.rename(corruptPath, filePath).catch(() => {});
                    this.recordRuntimeIssue(snapshotDir, {
                        code: 'index_rebuild_write_failed',
                        message: writeError.message,
                    });
                    throw writeError;
                }
            }
        }

        const working = clone(index);
        const changed = await inspectDisk(working, snapshotDir, this.fs);
        if (changed) {
            try {
                await this.atomicWrite(filePath, working);
                index = working;
            } catch (error) {
                this.recordRuntimeIssue(snapshotDir, { code: 'index_audit_write_failed', message: error.message });
            }
        }
        refreshHealth(index, this.runtimeFor(snapshotDir));
        this.cache.set(snapshotDir, index);
        return index;
    }

    async read(snapshotDir, reader) {
        return this.queue.run(snapshotDir, async () => {
            const index = await this.load(snapshotDir);
            const view = clone(index);
            refreshHealth(view, this.runtimeFor(snapshotDir));
            return reader(view);
        });
    }

    async mutate(snapshotDir, mutator) {
        return this.queue.run(snapshotDir, async () => {
            const committed = await this.load(snapshotDir);
            const working = clone(committed);
            refreshHealth(working, this.runtimeFor(snapshotDir));
            const transaction = new FileTransaction(snapshotDir, this.fs);
            let result;
            let phase = 'mutator';
            try {
                result = await mutator(working, transaction);
                refreshHealth(working, this.runtimeFor(snapshotDir));
                phase = 'index-write';
                await this.atomicWrite(path.join(snapshotDir, INDEX_FILE), working);
            } catch (error) {
                let rollback = 'completed';
                try {
                    await transaction.rollback();
                } catch (rollbackError) {
                    rollback = 'failed';
                    const causes = Array.isArray(rollbackError.errors)
                        ? rollbackError.errors.slice(0, 5).map((cause) => String(cause?.message || cause).slice(0, 300))
                        : [String(rollbackError.message || rollbackError).slice(0, 300)];
                    this.recordRuntimeIssue(snapshotDir, {
                        code: 'transaction_rollback_failed',
                        message: rollbackError.message,
                        transactionId: transaction.id,
                        failureCount: Array.isArray(rollbackError.errors) ? rollbackError.errors.length : 1,
                        causes,
                    });
                    error.rollbackFailure = {
                        transactionId: transaction.id,
                        failureCount: Array.isArray(rollbackError.errors) ? rollbackError.errors.length : 1,
                    };
                }
                if (phase === 'index-write') {
                    this.recordRuntimeIssue(snapshotDir, {
                        code: 'index_write_failed',
                        message: error.message,
                    });
                }
                error.rollback = rollback;
                throw error;
            }

            this.cache.set(snapshotDir, working);
            try {
                await transaction.finalize();
            } catch (error) {
                const issue = {
                    code: 'cleanup_failed',
                    message: error.message,
                    transactionId: transaction.id,
                };
                this.recordRuntimeIssue(snapshotDir, issue);
                working.health.lastCleanupFailure = { at: new Date().toISOString(), message: error.message };
                addIssue(working, issue);
                refreshHealth(working, this.runtimeFor(snapshotDir));
                this.cache.set(snapshotDir, working);
                try {
                    await this.atomicWrite(path.join(snapshotDir, INDEX_FILE), working);
                } catch (writeError) {
                    this.recordRuntimeIssue(snapshotDir, {
                        code: 'cleanup_health_write_failed',
                        message: writeError.message,
                    });
                }
            }
            return result;
        });
    }

    async health(snapshotDir) {
        return this.queue.run(snapshotDir, async () => {
            const committed = await this.load(snapshotDir);
            const working = clone(committed);
            const changed = await inspectDisk(working, snapshotDir, this.fs);
            refreshHealth(working, this.runtimeFor(snapshotDir));
            if (changed) {
                try {
                    await this.atomicWrite(path.join(snapshotDir, INDEX_FILE), working);
                    this.cache.set(snapshotDir, working);
                } catch (error) {
                    this.recordRuntimeIssue(snapshotDir, { code: 'health_write_failed', message: error.message });
                }
            }
            refreshHealth(working, this.runtimeFor(snapshotDir));
            return clone(working.health);
        });
    }

    assertDestructiveAllowed(snapshotDir, index, operation) {
        refreshHealth(index, this.runtimeFor(snapshotDir));
        if (!index.health.destructiveBlocked) return;
        const error = new Error(`存储处于降级状态，已阻止 ${operation}。请先核对隔离项和健康问题。`);
        error.statusCode = 423;
        error.code = 'storage_degraded';
        error.details = { health: clone(index.health) };
        throw error;
    }

    adoptIdentity(index, identity) {
        const matches = currentTargetRecords(index, identity);
        if (matches.length > 1) throw canonicalTargetAmbiguous();

        let direct = matches[0];
        if (!direct) {
            const canonicalId = allocateCanonicalId(index, identity.canonicalId);
            direct = {
                canonicalId,
                kind: identity.kind,
                entityId: identity.entityId,
                entityName: identity.entityName,
                chatId: identity.chatId,
                pathSemantic: identity.pathSemantic,
                legacyId: identity.legacyId,
                legacy: false,
                deletedAt: null,
                latestContentHash: '',
                updatedAt: new Date().toISOString(),
            };
            index.chats[canonicalId] = direct;
        } else {
            Object.assign(direct, {
                kind: identity.kind,
                entityId: identity.entityId,
                entityName: identity.entityName,
                chatId: identity.chatId,
                pathSemantic: identity.pathSemantic,
                legacy: false,
                updatedAt: new Date().toISOString(),
            });
        }

        const canonicalId = direct.canonicalId;

        const legacyCollision = Object.values(index.chats).some((chat) =>
            chat.canonicalId !== canonicalId && chat.legacyId === identity.legacyId);

        for (const [quarantineId, item] of Object.entries(index.quarantine)) {
            const exactV2 = item.canonicalHint && item.canonicalHint === canonicalId;
            const exactLegacy = item.legacyId && item.legacyId === identity.legacyId && !legacyCollision;
            if (!exactV2 && !exactLegacy) continue;

            const deleted = item.deletedEvidence;
            const deletionProven = exactLegacy
                && deleted
                && String(deleted.entityId || '').replace(/\.png$/i, '') === identity.entityId
                && String(deleted.chatId || '').replace(/\.jsonl$/i, '') === identity.chatId
                && Boolean(deleted.isGroup) === identity.isGroup;
            index.snapshots[item.name] = {
                name: item.name,
                canonicalId,
                kind: identity.kind,
                label: item.label,
                legacyId: item.legacyId,
                messageCount: item.messageCount,
                bytes: item.bytes,
                mtimeMs: item.mtimeMs,
                createdAt: new Date(item.mtimeMs).toISOString(),
                status: item.status,
                kept: item.reliableKept === true,
                trashedAt: deletionProven ? deleted.deletedAt || new Date().toISOString() : null,
                trashReason: deletionProven ? 'chat-deleted' : null,
                contentHash: '',
            };
            if (deletionProven) direct.deletedAt ||= index.snapshots[item.name].trashedAt;
            delete index.quarantine[quarantineId];
        }
        refreshHealth(index);
        return direct;
    }

    findIdentityByOpaque(index, opaqueKey) {
        const key = String(opaqueKey || '');
        if (!/^[a-f0-9]{24}$/.test(key) || !index.chats[key] || index.chats[key].legacy) {
            const error = new Error('opaque chat identity is invalid or unavailable');
            error.statusCode = 400;
            error.code = 'invalid_opaque_identity';
            throw error;
        }
        return index.chats[key];
    }

    resolveCurrentTarget(index, request, opaqueKey) {
        const record = this.findIdentityByOpaque(index, opaqueKey);
        const identity = identityFromRecord(request, record);
        const matches = currentTargetRecords(index, identity);
        if (matches.length !== 1 || matches[0] !== record) {
            throw canonicalTargetAmbiguous();
        }
        return identity;
    }

    remapCharacter(index, oldEntityId, newEntityId) {
        const sourceId = plainFileId(oldEntityId, 'old character id').replace(/\.png$/i, '');
        const destinationId = plainFileId(newEntityId, 'new character id').replace(/\.png$/i, '');
        const candidates = Object.values(index.chats)
            .filter((chat) => !chat.legacy && chat.kind === 'char' && chat.entityId === sourceId);
        const planned = new Set();

        for (const chat of candidates) {
            const chatId = plainFileId(chat.chatId, 'stored chat id');
            const target = {
                kind: 'char',
                entityId: destinationId,
                chatId,
                pathSemantic: `chats/${destinationId}/${chatId}.jsonl`,
            };
            const targetKey = `${target.kind}\0${target.entityId}\0${target.chatId}`;
            if (planned.has(targetKey)
                || currentTargetRecords(index, target).some((other) => other !== chat)) {
                throw canonicalTargetAmbiguous();
            }
            planned.add(targetKey);
        }

        const updatedAt = new Date().toISOString();
        for (const chat of candidates) {
            const chatId = plainFileId(chat.chatId, 'stored chat id');
            chat.entityId = destinationId;
            chat.pathSemantic = `chats/${destinationId}/${chatId}.jsonl`;
            chat.updatedAt = updatedAt;
        }
        return { remapped: candidates.length };
    }

    remapChat(index, oldIdentity, newIdentity) {
        if (oldIdentity.kind !== newIdentity.kind || oldIdentity.entityId !== newIdentity.entityId) {
            throw canonicalTargetAmbiguous('chat rename target is outside its current entity');
        }
        const candidates = currentTargetRecords(index, oldIdentity);
        if (candidates.length === 0) return { remapped: 0 };
        if (candidates.length !== 1) throw canonicalTargetAmbiguous();

        const chat = candidates[0];
        if (currentTargetRecords(index, newIdentity).some((other) => other !== chat)) {
            throw canonicalTargetAmbiguous();
        }
        chat.chatId = newIdentity.chatId;
        chat.pathSemantic = newIdentity.pathSemantic;
        chat.updatedAt = new Date().toISOString();
        return { remapped: 1, opaqueKey: chat.canonicalId };
    }

    lookupDeletionIdentity(index, kind, chatId) {
        const candidates = Object.values(index.chats)
            .filter((chat) => !chat.legacy && chat.kind === kind && chat.chatId === chatId)
            .map((chat) => chat.canonicalId);
        if (candidates.length === 1) return { opaqueKey: candidates[0], pending: false };
        const reviewId = crypto.randomBytes(10).toString('hex');
        index.review[reviewId] = {
            reviewId,
            type: 'deletion_identity_unresolved',
            kind,
            chatId,
            candidates,
            occurredAt: new Date().toISOString(),
        };
        refreshHealth(index);
        return { pending: true, reviewId, candidates: candidates.length };
    }

    acknowledgeRepair(index) {
        index.health.repairConfirmedAt = new Date().toISOString();
        for (const issue of index.health.issues) {
            if (['index_corrupt', 'quarantine_items'].includes(issue.code)) {
                issue.confirmedAt = index.health.repairConfirmedAt;
            }
        }
        refreshHealth(index);
        return clone(index.health);
    }

    clearCache() {
        this.cache.clear();
    }
}

module.exports = {
    FileTransaction,
    INDEX_FILE,
    InventoryOwner,
    TRANSACTION_DIR,
    atomicWriteJson,
    atomicWriteText,
    emptyIndex,
    parseLegacyName,
    parseV2Name,
    refreshHealth,
    scanExisting,
};

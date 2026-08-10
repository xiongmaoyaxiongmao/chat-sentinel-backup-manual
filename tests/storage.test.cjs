const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { resolveChatIdentity } = require('../plugins/chat-sentinel-backup/lib/identity.cjs');
const {
    InventoryOwner,
    INDEX_FILE,
    TRANSACTION_DIR,
} = require('../plugins/chat-sentinel-backup/lib/inventory.cjs');
const { sendError } = require('../plugins/chat-sentinel-backup/lib/controller.cjs');
const { RecoveryService } = require('../plugins/chat-sentinel-backup/lib/recovery.cjs');
const { SnapshotService } = require('../plugins/chat-sentinel-backup/lib/snapshot-service.cjs');
const { jsonl, makeProfile, writeCharacterChat, writeGroupChat } = require('./helpers.cjs');

function raw(overrides = {}) {
    return {
        isGroup: false,
        entityId: 'fixture.png',
        entityName: '旧名字',
        chatId: 'story',
        reason: 'manual',
        keepPerChat: 80,
        ...overrides,
    };
}

async function register(service, profile, overrides = {}) {
    const result = await service.registerIdentity(profile.request, raw(overrides));
    return result.opaqueKey;
}

function opaque(opaqueKey, overrides = {}) {
    return { opaqueKey, reason: 'manual', keepPerChat: 80, ...overrides };
}

test('显示名变化不改变 identity，路径穿越被拒绝', async (t) => {
    const profile = await makeProfile('identity');
    t.after(profile.cleanup);
    const before = resolveChatIdentity(profile.request, raw());
    const after = resolveChatIdentity(profile.request, raw({ entityName: '新名字' }));
    assert.equal(before.canonicalId, after.canonicalId);
    assert.throws(() => resolveChatIdentity(profile.request, raw({ chatId: '../escape' })), /invalid|outside/);
    assert.throws(() => resolveChatIdentity(profile.request, raw({ entityId: '../escape.png' })), /invalid|outside/);
});

test('角色改名 remap 保持 opaque key，恢复只写入当前角色目录', async (t) => {
    const profile = await makeProfile('character-remap');
    t.after(profile.cleanup);
    const savedText = jsonl(4, 'character-saved');
    const oldTarget = await writeCharacterChat(profile, 'fixture.png', 'story', savedText);
    const inventory = new InventoryOwner();
    const service = new SnapshotService(inventory);
    const recovery = new RecoveryService(inventory);
    const key = await register(service, profile);
    const saved = await service.snapshot(profile.request, opaque(key));

    const newDirectory = path.join(profile.directories.chats, 'renamed');
    await fs.promises.rename(path.dirname(oldTarget), newDirectory);
    const remapped = await service.remapCharacter(profile.request, {
        oldAvatar: 'fixture.png',
        newAvatar: 'renamed.png',
    });
    assert.deepEqual(remapped, { remapped: 1 });
    const resolved = await register(service, profile, { entityId: 'renamed.png', entityName: '新名字' });
    assert.equal(resolved, key);

    const newTarget = path.join(newDirectory, 'story.jsonl');
    await fs.promises.writeFile(newTarget, jsonl(2, 'character-current'), 'utf8');
    await recovery.restore(profile.request, { opaqueKey: key, name: saved.file });
    assert.equal(await fs.promises.readFile(newTarget, 'utf8'), savedText);
    assert.equal(await fs.promises.stat(oldTarget).then(() => true, () => false), false);
});

test('聊天改名后旧路径复用分配新 opaque key，恢复不串写新聊天', async (t) => {
    const profile = await makeProfile('chat-remap');
    t.after(profile.cleanup);
    const savedText = jsonl(4, 'chat-saved');
    const oldTarget = await writeCharacterChat(profile, 'fixture.png', 'story', savedText);
    const inventory = new InventoryOwner();
    const service = new SnapshotService(inventory);
    const recovery = new RecoveryService(inventory);
    const key = await register(service, profile);
    const saved = await service.snapshot(profile.request, opaque(key));

    const renamedTarget = path.join(path.dirname(oldTarget), 'renamed.jsonl');
    await fs.promises.rename(oldTarget, renamedTarget);
    const remapped = await service.remapChat(profile.request, {
        isGroup: false,
        entityId: 'fixture.png',
        oldFileName: 'story.jsonl',
        newFileName: 'renamed.jsonl',
    });
    assert.deepEqual(remapped, { remapped: 1, opaqueKey: key });
    assert.equal(await register(service, profile, { chatId: 'renamed' }), key);

    const reusedText = jsonl(3, 'reused-story');
    await writeCharacterChat(profile, 'fixture.png', 'story', reusedText);
    const reusedKey = await register(service, profile, { chatId: 'story' });
    assert.notEqual(reusedKey, key);
    await fs.promises.writeFile(renamedTarget, jsonl(1, 'renamed-current'), 'utf8');

    await recovery.restore(profile.request, { opaqueKey: key, name: saved.file });
    assert.equal(await fs.promises.readFile(renamedTarget, 'utf8'), savedText);
    assert.equal(await fs.promises.readFile(oldTarget, 'utf8'), reusedText);
    const current = await inventory.read(path.join(profile.directories.backups, 'sentinel-chat'), (index) => ({
        original: index.chats[key],
        reused: index.chats[reusedKey],
    }));
    assert.equal(current.original.chatId, 'renamed');
    assert.equal(current.reused.chatId, 'story');
});

test('重复 current target 时恢复 fail closed，且不创建或覆盖目标', async (t) => {
    const profile = await makeProfile('canonical-ambiguity');
    t.after(profile.cleanup);
    const target = await writeCharacterChat(profile, 'fixture.png', 'story', jsonl(4, 'saved'));
    const inventory = new InventoryOwner();
    const service = new SnapshotService(inventory);
    const recovery = new RecoveryService(inventory);
    const key = await register(service, profile);
    const saved = await service.snapshot(profile.request, opaque(key));
    const snapshotDir = path.join(profile.directories.backups, 'sentinel-chat');
    const duplicateKey = key === 'a'.repeat(24) ? 'b'.repeat(24) : 'a'.repeat(24);
    await inventory.mutate(snapshotDir, (index) => {
        index.chats[duplicateKey] = { ...index.chats[key], canonicalId: duplicateKey };
    });
    const indexBefore = await fs.promises.readFile(path.join(snapshotDir, INDEX_FILE), 'utf8');
    const targetBefore = await fs.promises.readFile(target, 'utf8');

    await assert.rejects(
        recovery.restore(profile.request, { opaqueKey: key, name: saved.file }),
        (error) => error.code === 'canonical_target_ambiguous' && error.statusCode === 409,
    );
    assert.equal(await fs.promises.readFile(target, 'utf8'), targetBefore);
    assert.equal(await fs.promises.readFile(path.join(snapshotDir, INDEX_FILE), 'utf8'), indexBefore);
});

test('同秒同消息数不碰撞，并在重启后持久去重', async (t) => {
    const profile = await makeProfile('dedupe');
    t.after(profile.cleanup);
    await writeCharacterChat(profile, 'fixture.png', 'story', jsonl(4, 'one'));
    const firstService = new SnapshotService(new InventoryOwner());
    const key = await register(firstService, profile);
    const first = await firstService.snapshot(profile.request, opaque(key));
    await writeCharacterChat(profile, 'fixture.png', 'story', jsonl(4, 'two'));
    const second = await firstService.snapshot(profile.request, opaque(key));
    assert.notEqual(first.file, second.file);

    const restarted = new SnapshotService(new InventoryOwner());
    const duplicate = await restarted.snapshot(profile.request, opaque(key));
    assert.equal(duplicate.skipped, true);
});

test('合法大幅删改必须人工确认，并保护旧完整版本', async (t) => {
    const profile = await makeProfile('regression');
    t.after(profile.cleanup);
    await writeCharacterChat(profile, 'fixture.png', 'story', jsonl(100, 'full'));
    const service = new SnapshotService(new InventoryOwner());
    const key = await register(service, profile);
    await service.snapshot(profile.request, opaque(key));
    await writeCharacterChat(profile, 'fixture.png', 'story', jsonl(10, 'edited'));
    await assert.rejects(service.snapshot(profile.request, opaque(key, { reason: 'auto' })), (error) => {
        assert.equal(error.code, 'message_count_regression');
        assert.equal(error.details.baselineMessageCount, 100);
        return true;
    });
    const confirmed = await service.snapshot(profile.request, opaque(key, { confirmRegression: true }));
    assert.equal(confirmed.status, 'confirmed');
    const history = await service.current(profile.request, opaque(key));
    assert.equal(history.snapshots.find((item) => item.messageCount === 100).kept, true);
});

test('每个聊天固定使用十个原子循环槽，并从最早槽开始覆盖', async (t) => {
    const profile = await makeProfile('rolling-slots');
    t.after(profile.cleanup);
    const inventory = new InventoryOwner();
    const service = new SnapshotService(inventory);
    const key = await register(service, profile);
    for (let index = 0; index < 12; index += 1) {
        await writeCharacterChat(profile, 'fixture.png', 'story', jsonl(3, `v${index}`));
        await service.snapshot(profile.request, opaque(key));
    }
    const current = await service.current(profile.request, opaque(key));
    assert.equal(current.snapshots.length, 10);
    assert.deepEqual([...new Set(current.snapshots.map((item) => item.slot))].sort((a, b) => a - b), Array.from({ length: 10 }, (_, index) => index));
    const snapshotDir = path.join(profile.directories.backups, 'sentinel-chat');
    const names = (await fs.promises.readdir(snapshotDir)).filter((name) => name.startsWith(`ring-${key}-`));
    assert.equal(names.length, 10);
    const savedTexts = await Promise.all(names.map((name) => fs.promises.readFile(path.join(snapshotDir, name), 'utf8')));
    assert.equal(savedTexts.some((text) => text.includes('v0-0') || text.includes('v1-0')), false);
    for (let index = 2; index < 12; index += 1) {
        assert.equal(savedTexts.some((text) => text.includes(`v${index}-0`)), true);
    }
});

test('旧快照保持原样，新循环槽不再把它们当作可增长历史', async (t) => {
    const profile = await makeProfile('legacy-isolation');
    t.after(profile.cleanup);
    const identity = resolveChatIdentity(profile.request, raw());
    const snapshotDir = path.join(profile.directories.backups, 'sentinel-chat');
    await fs.promises.mkdir(snapshotDir, { recursive: true });
    const legacyNames = [];
    for (let index = 0; index < 5; index += 1) {
        const name = `20260627-12000${index}_char_旧名字_${identity.legacyId}_m4.jsonl`;
        const filePath = path.join(snapshotDir, name);
        await fs.promises.writeFile(filePath, jsonl(4, `legacy-${index}`), 'utf8');
        const mtime = new Date(Date.UTC(2026, 5, 27, 12, 0, index));
        await fs.promises.utimes(filePath, mtime, mtime);
        legacyNames.push(name);
    }
    await writeCharacterChat(profile, 'fixture.png', 'story', jsonl(4, 'v2-first'));

    const service = new SnapshotService(new InventoryOwner());
    const key = await register(service, profile);
    const before = await service.current(profile.request, opaque(key));
    assert.equal(before.snapshots.filter((item) => item.status === 'legacy').length, 5);
    assert.equal(before.snapshots.filter((item) => item.status === 'legacy' && !item.kept).length, 5);

    const firstV2 = await service.snapshot(profile.request, opaque(key));
    const after = await service.current(profile.request, opaque(key));
    for (const name of legacyNames) {
        assert.equal(await fs.promises.stat(path.join(snapshotDir, name)).then(() => true, () => false), true);
    }
    assert.equal(after.snapshots.filter((item) => item.name === firstV2.file).length, 1);
    assert.equal(after.snapshots.length, 1);
    assert.equal(after.snapshots[0].rolling, true);
});

test('字符、群聊、整卡和选择备份都使用服务端 opaque identity', async (t) => {
    const profile = await makeProfile('bulk');
    t.after(profile.cleanup);
    await writeCharacterChat(profile, 'fixture.png', 'one', jsonl(2, 'one'));
    await writeCharacterChat(profile, 'fixture.png', 'two', jsonl(2, 'two'));
    const service = new SnapshotService(new InventoryOwner());
    const key = await register(service, profile, { chatId: 'one' });
    const chats = await service.entityChats(profile.request, opaque(key));
    assert.equal(chats.length, 2);
    assert.ok(chats.every((chat) => /^[a-f0-9]{24}$/.test(chat.opaqueKey)));
    const all = await service.snapshotMany(profile.request, opaque(key));
    assert.equal(all.written, 2);
    const selected = await service.snapshotMany(profile.request, opaque(key), [chats[0].opaqueKey]);
    assert.equal(selected.total, 1);

    await writeGroupChat(profile, 'g1', 'group-story', jsonl(2, 'group'));
    const groupKey = await register(service, profile, {
        isGroup: true,
        entityId: 'g1',
        entityName: '测试群',
        chatId: 'group-story',
    });
    const groupResult = await service.snapshot(profile.request, opaque(groupKey));
    assert.equal(groupResult.messageCount, 2);
});

test('损坏 JSONL 拒绝恢复，成功恢复会占用一个循环保护槽', async (t) => {
    const profile = await makeProfile('restore');
    t.after(profile.cleanup);
    const target = await writeCharacterChat(profile, 'fixture.png', 'story', jsonl(4, 'original'));
    const inventory = new InventoryOwner();
    const service = new SnapshotService(inventory);
    const recovery = new RecoveryService(inventory);
    const key = await register(service, profile);
    const saved = await service.snapshot(profile.request, opaque(key));
    await writeCharacterChat(profile, 'fixture.png', 'story', jsonl(2, 'current'));
    const restored = await recovery.restore(profile.request, { opaqueKey: key, name: saved.file });
    assert.ok(restored.preRestoreSnapshot);
    assert.equal(await fs.promises.readFile(target, 'utf8'), jsonl(4, 'original'));
    const history = await service.current(profile.request, opaque(key));
    const insurance = history.snapshots.find((item) => item.name === restored.preRestoreSnapshot);
    assert.equal(insurance.rolling, true);
    assert.equal(insurance.status, 'pre-restore');

    const snapshotDir = path.join(profile.directories.backups, 'sentinel-chat');
    await fs.promises.writeFile(path.join(snapshotDir, saved.file), `${jsonl(1)}{broken}\n`, 'utf8');
    await assert.rejects(recovery.restore(profile.request, { opaqueKey: key, name: saved.file }), /损坏/);
});

test('恢复替换后 hook 失败会回滚原目标且不留下保险快照', async (t) => {
    const profile = await makeProfile('rollback-hook');
    t.after(profile.cleanup);
    const target = await writeCharacterChat(profile, 'fixture.png', 'story', jsonl(3, 'saved'));
    const inventory = new InventoryOwner();
    const service = new SnapshotService(inventory);
    const key = await register(service, profile);
    const saved = await service.snapshot(profile.request, opaque(key));
    await writeCharacterChat(profile, 'fixture.png', 'story', jsonl(2, 'current'));
    const currentBefore = await fs.promises.readFile(target, 'utf8');
    const filesBefore = await fs.promises.readdir(path.join(profile.directories.backups, 'sentinel-chat'));
    const recovery = new RecoveryService(inventory, {
        afterReplace: async () => { throw new Error('injected failure'); },
    });
    await assert.rejects(
        recovery.restore(profile.request, { opaqueKey: key, name: saved.file }),
        (error) => {
            assert.match(error.message, /injected failure/);
            assert.equal(error.rollback, 'completed');
            return true;
        },
    );
    assert.equal(await fs.promises.readFile(target, 'utf8'), currentBefore);
    assert.deepEqual(
        (await fs.promises.readdir(path.join(profile.directories.backups, 'sentinel-chat'))).sort(),
        filesBefore.sort(),
    );
});

test('rollback 逆操作失败会返回 failed、保留现场并将 health 标为 degraded', async (t) => {
    const profile = await makeProfile('rollback-inverse-failure');
    t.after(profile.cleanup);
    let failTargetRestore = false;
    const fsApi = new Proxy(fs.promises, {
        get(target, property) {
            const value = target[property];
            if (property === 'rename') {
                return async (source, destination) => {
                    if (failTargetRestore
                        && String(source).includes('.sentinel-tx-')
                        && String(source).endsWith('.bak')
                        && String(destination).endsWith(`${path.sep}story.jsonl`)) {
                        throw new Error('injected inverse rename failure');
                    }
                    return target.rename(source, destination);
                };
            }
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    const inventory = new InventoryOwner({ fs: fsApi });
    const service = new SnapshotService(inventory);
    const target = await writeCharacterChat(profile, 'fixture.png', 'story', jsonl(4, 'saved'));
    const key = await register(service, profile);
    const saved = await service.snapshot(profile.request, opaque(key));
    await writeCharacterChat(profile, 'fixture.png', 'story', jsonl(2, 'current'));
    const snapshotDir = path.join(profile.directories.backups, 'sentinel-chat');
    const indexBefore = await fs.promises.readFile(path.join(snapshotDir, INDEX_FILE), 'utf8');
    failTargetRestore = true;
    const recovery = new RecoveryService(inventory, {
        afterReplace: async () => { throw new Error('original restore operation failure'); },
    });

    let failure;
    try {
        await recovery.restore(profile.request, { opaqueKey: key, name: saved.file });
    } catch (error) {
        failure = error;
    }
    assert.ok(failure);
    assert.equal(failure.message, 'original restore operation failure');
    assert.equal(failure.rollback, 'failed');
    assert.equal(failure.rollbackFailure.failureCount, 1);

    let responseBody;
    const response = {
        headersSent: false,
        statusCode: 0,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(value) {
            responseBody = value;
        },
    };
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
        sendError(response, failure, 'restore-test');
    } finally {
        console.error = originalConsoleError;
    }
    assert.equal(responseBody.rollback, 'failed');
    assert.equal(responseBody.error, 'original restore operation failure');

    assert.equal(await fs.promises.stat(target).then(() => true, () => false), false);
    const targetBackups = (await fs.promises.readdir(path.dirname(target)))
        .filter((name) => name.startsWith('story.jsonl.sentinel-tx-') && name.endsWith('.bak'));
    assert.equal(targetBackups.length, 1);
    assert.equal(await fs.promises.readFile(path.join(snapshotDir, INDEX_FILE), 'utf8'), indexBefore);

    const health = await inventory.health(snapshotDir);
    assert.equal(health.degraded, true);
    assert.equal(health.destructiveBlocked, true);
    const rollbackIssue = health.issues.find((issue) => issue.code === 'transaction_rollback_failed');
    assert.equal(rollbackIssue.failureCount, 1);
    assert.deepEqual(rollbackIssue.causes, ['injected inverse rename failure']);
    assert.ok(health.issues.some((issue) => issue.code === 'transaction_remnants'));
    const indexed = await inventory.read(snapshotDir, (index) => ({
        snapshotStillIndexed: Boolean(index.snapshots[saved.file]),
        degraded: index.health.degraded,
    }));
    assert.deepEqual(indexed, { snapshotStillIndexed: true, degraded: true });
});

test('临时写入与反向恢复双重失败不会谎报 rollback completed', async (t) => {
    const profile = await makeProfile('rollback-double-failure');
    t.after(profile.cleanup);
    let targetPath = '';
    let failTemporaryWrite = false;
    let failInverseRename = false;
    const fsApi = new Proxy(fs.promises, {
        get(target, property) {
            const value = target[property];
            if (property === 'open') {
                return async (filePath, ...args) => {
                    if (failTemporaryWrite
                        && String(filePath).startsWith(`${targetPath}.`)
                        && String(filePath).endsWith('.tmp')) {
                        throw new Error('injected temporary write failure');
                    }
                    return target.open(filePath, ...args);
                };
            }
            if (property === 'rename') {
                return async (source, destination) => {
                    if (failInverseRename
                        && String(source).startsWith(`${targetPath}.sentinel-tx-`)
                        && String(source).endsWith('.bak')
                        && String(destination) === targetPath) {
                        throw new Error('injected inverse rename failure');
                    }
                    return target.rename(source, destination);
                };
            }
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    const inventory = new InventoryOwner({ fs: fsApi });
    const service = new SnapshotService(inventory);
    targetPath = await writeCharacterChat(profile, 'fixture.png', 'story', jsonl(4, 'saved'));
    const key = await register(service, profile);
    const saved = await service.snapshot(profile.request, opaque(key));
    await writeCharacterChat(profile, 'fixture.png', 'story', jsonl(2, 'current'));
    const snapshotDir = path.join(profile.directories.backups, 'sentinel-chat');
    const indexBefore = await fs.promises.readFile(path.join(snapshotDir, INDEX_FILE), 'utf8');
    failTemporaryWrite = true;
    failInverseRename = true;

    let failure;
    try {
        await new RecoveryService(inventory).restore(profile.request, { opaqueKey: key, name: saved.file });
    } catch (error) {
        failure = error;
    }
    assert.ok(failure);
    assert.equal(failure.message, 'injected temporary write failure');
    assert.equal(failure.rollback, 'failed');
    assert.equal(failure.rollbackFailure.failureCount, 1);
    assert.equal(await fs.promises.stat(targetPath).then(() => true, () => false), false);
    const backups = (await fs.promises.readdir(path.dirname(targetPath)))
        .filter((name) => name.startsWith('story.jsonl.sentinel-tx-') && name.endsWith('.bak'));
    assert.equal(backups.length, 1);
    assert.equal((await fs.promises.readdir(path.join(snapshotDir, TRANSACTION_DIR))).length, 1);
    assert.equal(await fs.promises.readFile(path.join(snapshotDir, INDEX_FILE), 'utf8'), indexBefore);
    const committed = await inventory.read(snapshotDir, (index) => ({
        snapshotStillIndexed: Boolean(index.snapshots[saved.file]),
        preRestoreSnapshots: Object.values(index.snapshots).filter((item) => item.status === 'pre-restore').length,
    }));
    assert.deepEqual(committed, { snapshotStillIndexed: true, preRestoreSnapshots: 0 });

    const health = await inventory.health(snapshotDir);
    assert.equal(health.degraded, true);
    assert.equal(health.destructiveBlocked, true);
    const rollbackIssue = health.issues.find((issue) => issue.code === 'transaction_rollback_failed');
    assert.equal(rollbackIssue.failureCount, 1);
    assert.deepEqual(rollbackIssue.causes, ['injected inverse rename failure']);
    assert.ok(health.issues.some((issue) => issue.code === 'transaction_remnants'));
});

test('index 原子写失败不会提前污染 live cache 或磁盘索引', async (t) => {
    const profile = await makeProfile('index-atomic');
    t.after(profile.cleanup);
    const inventory = new InventoryOwner();
    const service = new SnapshotService(inventory);
    const key = await register(service, profile);
    const snapshotDir = path.join(profile.directories.backups, 'sentinel-chat');
    const diskBefore = await fs.promises.readFile(path.join(snapshotDir, INDEX_FILE), 'utf8');
    const cacheBefore = await inventory.read(snapshotDir, (index) => index.chats[key].entityName);
    inventory.atomicWrite = async () => { throw new Error('injected index write failure'); };
    await assert.rejects(inventory.mutate(snapshotDir, (index) => {
        index.chats[key].entityName = '不应提交';
    }), /injected index write failure/);
    assert.equal(await fs.promises.readFile(path.join(snapshotDir, INDEX_FILE), 'utf8'), diskBefore);
    assert.equal(await inventory.read(snapshotDir, (index) => index.chats[key].entityName), cacheBefore);
});

test('retention 在索引写失败时恢复所有暂存文件', async (t) => {
    const profile = await makeProfile('retention-rollback');
    t.after(profile.cleanup);
    const inventory = new InventoryOwner();
    const service = new SnapshotService(inventory);
    const key = await register(service, profile);
    for (let index = 0; index < 5; index += 1) {
        await writeCharacterChat(profile, 'fixture.png', 'story', jsonl(3, `v${index}`));
        await service.snapshot(profile.request, opaque(key, { keepPerChat: 5 }));
    }
    const snapshotDir = path.join(profile.directories.backups, 'sentinel-chat');
    const beforeRetention = (await fs.promises.readdir(snapshotDir)).filter((name) => name.endsWith('.jsonl')).sort();
    inventory.atomicWrite = async () => { throw new Error('retention index fail'); };
    await writeCharacterChat(profile, 'fixture.png', 'story', jsonl(3, 'v6'));
    await assert.rejects(service.snapshot(profile.request, opaque(key, { keepPerChat: 5 })), /retention index fail/);
    assert.deepEqual(
        (await fs.promises.readdir(snapshotDir)).filter((name) => name.endsWith('.jsonl')).sort(),
        beforeRetention,
    );

});

test('purge 在索引写失败时恢复已暂存删除文件', async (t) => {
    const profile = await makeProfile('purge-rollback');
    t.after(profile.cleanup);
    const inventory = new InventoryOwner();
    const service = new SnapshotService(inventory);
    await writeCharacterChat(profile, 'fixture.png', 'story', jsonl(3, 'purge'));
    const key = await register(service, profile);
    const saved = await service.snapshot(profile.request, opaque(key));
    await service.moveToTrash(profile.request, { opaqueKey: key, selected: [saved.file] });
    const snapshotDir = path.join(profile.directories.backups, 'sentinel-chat');
    const beforePurge = await fs.promises.readFile(path.join(snapshotDir, saved.file), 'utf8');
    inventory.atomicWrite = async () => { throw new Error('purge index fail'); };
    await assert.rejects(service.purgeTrash(profile.request, [saved.file]), /purge index fail/);
    assert.equal(await fs.promises.readFile(path.join(snapshotDir, saved.file), 'utf8'), beforePurge);
    assert.equal((await service.trash(profile.request)).snapshots.some((item) => item.name === saved.file), true);
});

test('目标已替换后索引写失败会同时回滚目标、保险快照与 cache', async (t) => {
    const profile = await makeProfile('restore-index-rollback');
    t.after(profile.cleanup);
    const target = await writeCharacterChat(profile, 'fixture.png', 'story', jsonl(4, 'saved'));
    const inventory = new InventoryOwner();
    const service = new SnapshotService(inventory);
    const key = await register(service, profile);
    const saved = await service.snapshot(profile.request, opaque(key));
    const current = jsonl(2, 'current');
    await writeCharacterChat(profile, 'fixture.png', 'story', current);
    const snapshotDir = path.join(profile.directories.backups, 'sentinel-chat');
    const filesBefore = (await fs.promises.readdir(snapshotDir)).sort();
    const indexBefore = await fs.promises.readFile(path.join(snapshotDir, INDEX_FILE), 'utf8');
    inventory.atomicWrite = async () => { throw new Error('restore index fail'); };
    await assert.rejects(
        new RecoveryService(inventory).restore(profile.request, { opaqueKey: key, name: saved.file }),
        /restore index fail/,
    );
    assert.equal(await fs.promises.readFile(target, 'utf8'), current);
    assert.equal(await fs.promises.readFile(path.join(snapshotDir, INDEX_FILE), 'utf8'), indexBefore);
    assert.deepEqual((await fs.promises.readdir(snapshotDir)).sort(), filesBefore);
    assert.equal((await service.current(profile.request, opaque(key))).snapshots.some((item) => item.status === 'pre-restore'), false);
});

test('群聊恢复的目标和 group metadata 在索引写失败时一起回滚', async (t) => {
    const profile = await makeProfile('group-restore-index-rollback');
    t.after(profile.cleanup);
    const target = await writeGroupChat(profile, 'g1', 'group-story', jsonl(4, 'saved-group'));
    const inventory = new InventoryOwner();
    const service = new SnapshotService(inventory);
    const key = await register(service, profile, {
        isGroup: true,
        entityId: 'g1',
        entityName: '测试群',
        chatId: 'group-story',
    });
    const saved = await service.snapshot(profile.request, opaque(key));
    const current = jsonl(2, 'current-group');
    await fs.promises.writeFile(target, current, 'utf8');
    const groupPath = path.join(profile.directories.groups, 'g1.json');
    const groupBefore = `${JSON.stringify({ id: 'g1', name: 'Fixture Group', chats: [], chat_id: '' }, null, 2)}\n`;
    await fs.promises.writeFile(groupPath, groupBefore, 'utf8');
    inventory.atomicWrite = async () => { throw new Error('group restore index fail'); };
    await assert.rejects(
        new RecoveryService(inventory).restore(profile.request, { opaqueKey: key, name: saved.file }),
        /group restore index fail/,
    );
    assert.equal(await fs.promises.readFile(target, 'utf8'), current);
    assert.equal(await fs.promises.readFile(groupPath, 'utf8'), groupBefore);
});

test('删除非当前角色可唯一解析；同 chatId 跨角色与批量未知删除 fail closed', async (t) => {
    const profile = await makeProfile('delete-lookup');
    t.after(profile.cleanup);
    const inventory = new InventoryOwner();
    const service = new SnapshotService(inventory);
    await writeCharacterChat(profile, 'a.png', 'shared', jsonl(2, 'a'));
    await writeCharacterChat(profile, 'b.png', 'shared', jsonl(2, 'b'));
    const a = await register(service, profile, { entityId: 'a.png', entityName: 'A', chatId: 'shared' });
    const b = await register(service, profile, { entityId: 'b.png', entityName: 'B', chatId: 'shared' });
    await service.snapshot(profile.request, opaque(a));
    await service.snapshot(profile.request, opaque(b));
    const ambiguous = await service.deletionLookup(profile.request, { kind: 'char', chatId: 'shared' });
    assert.equal(ambiguous.pending, true);
    assert.equal((await service.trash(profile.request)).snapshots.length, 0);
    const unknown = await service.deletionLookup(profile.request, { kind: 'char', chatId: 'batch-unknown' });
    assert.equal(unknown.pending, true);

    await writeCharacterChat(profile, 'c.png', 'non-current', jsonl(2, 'c'));
    const c = await register(service, profile, { entityId: 'c.png', entityName: 'C', chatId: 'non-current' });
    await service.snapshot(profile.request, opaque(c));
    const unique = await service.deletionLookup(profile.request, { kind: 'char', chatId: 'non-current' });
    assert.deepEqual(unique, { opaqueKey: c, pending: false });
    await service.markChatDeleted(profile.request, { opaqueKey: unique.opaqueKey });
    assert.equal((await service.trash(profile.request)).snapshots.some((item) => item.opaqueKey === c), true);
});

test('跨用户 opaque key 隔离，错误身份不能预览或恢复', async (t) => {
    const first = await makeProfile('user-a');
    const second = await makeProfile('user-b');
    t.after(first.cleanup);
    t.after(second.cleanup);
    await writeCharacterChat(first, 'fixture.png', 'story', jsonl(2, 'private-a'));
    await writeCharacterChat(second, 'fixture.png', 'story', jsonl(2, 'private-b'));
    const inventory = new InventoryOwner();
    const service = new SnapshotService(inventory);
    const key = await register(service, first);
    const saved = await service.snapshot(first.request, opaque(key));
    await assert.rejects(service.preview(second.request, { opaqueKey: key, name: saved.file }), /opaque/);
    await assert.rejects(new RecoveryService(inventory).restore(second.request, {
        opaqueKey: key,
        name: saved.file,
    }), /opaque/);
});

test('同 chatId 跨角色的旧文件不猜归属，原名保留为隔离项且迁移可重入', async (t) => {
    const profile = await makeProfile('migration-ambiguous');
    t.after(profile.cleanup);
    const snapshotDir = path.join(profile.directories.backups, 'sentinel-chat');
    await fs.promises.mkdir(snapshotDir, { recursive: true });
    const legacy = '20260627-123456_char_旧名字_story_aaaaaaaaaaaaaaaa_m4.jsonl';
    await fs.promises.writeFile(path.join(snapshotDir, legacy), jsonl(4, 'legacy'), 'utf8');
    const inventory = new InventoryOwner();
    const service = new SnapshotService(inventory);
    await register(service, profile, { entityId: 'a.png', entityName: 'A', chatId: 'story' });
    await register(service, profile, { entityId: 'b.png', entityName: 'B', chatId: 'story' });
    const history = await service.history(profile.request);
    assert.equal(history.groups.some((group) => group.snapshots.some((item) => item.name === legacy)), false);
    assert.equal(history.quarantine.some((item) => item.name === legacy), true);
    assert.equal(await fs.promises.readFile(path.join(snapshotDir, legacy), 'utf8'), jsonl(4, 'legacy'));
    inventory.clearCache();
    const afterRestart = await service.history(profile.request);
    assert.equal(afterRestart.quarantine.filter((item) => item.name === legacy).length, 1);
});

test('有完整 legacy identity 证据的旧文件只迁移一次且不改原名', async (t) => {
    const profile = await makeProfile('migration-exact');
    t.after(profile.cleanup);
    const identity = resolveChatIdentity(profile.request, raw());
    const snapshotDir = path.join(profile.directories.backups, 'sentinel-chat');
    await fs.promises.mkdir(snapshotDir, { recursive: true });
    const legacy = `20260627-123456_char_旧名字_${identity.legacyId}_m4.jsonl`;
    await fs.promises.writeFile(path.join(snapshotDir, legacy), jsonl(4, 'legacy-exact'), 'utf8');
    const inventory = new InventoryOwner();
    const service = new SnapshotService(inventory);
    const key = await register(service, profile);
    let current = await service.current(profile.request, opaque(key));
    assert.equal(current.snapshots.filter((item) => item.name === legacy).length, 1);
    assert.equal(await fs.promises.readFile(path.join(snapshotDir, legacy), 'utf8'), jsonl(4, 'legacy-exact'));
    inventory.clearCache();
    await service.registerIdentity(profile.request, raw({ entityName: '改名后' }));
    current = await service.current(profile.request, opaque(key));
    assert.equal(current.snapshots.filter((item) => item.name === legacy).length, 1);
});

test('损坏 v2 index 原件保全、重建不伪造元数据且 health degraded', async (t) => {
    const profile = await makeProfile('corrupt-index');
    t.after(profile.cleanup);
    const snapshotDir = path.join(profile.directories.backups, 'sentinel-chat');
    await fs.promises.mkdir(snapshotDir, { recursive: true });
    await fs.promises.writeFile(path.join(snapshotDir, INDEX_FILE), '{not-json', 'utf8');
    const unknown = '20260730T010203004Z__char__Fixture__caaaaaaaaaaaaaaaaaaaaaaaa__ubbbbbbbbbbbb__m4__manual.jsonl';
    await fs.promises.writeFile(path.join(snapshotDir, unknown), jsonl(4, 'unknown'), 'utf8');
    const inventory = new InventoryOwner();
    const health = await inventory.health(snapshotDir);
    assert.equal(health.degraded, true);
    assert.equal(health.destructiveBlocked, true);
    assert.ok(health.issues.some((issue) => issue.code === 'index_corrupt'));
    const names = await fs.promises.readdir(snapshotDir);
    assert.ok(names.some((name) => name.startsWith(`${INDEX_FILE}.corrupt-`)));
    const rebuilt = JSON.parse(await fs.promises.readFile(path.join(snapshotDir, INDEX_FILE), 'utf8'));
    assert.equal(Object.keys(rebuilt.snapshots).length, 0);
    assert.equal(rebuilt.quarantine[`file:${unknown}`].reliableKept, null);
    assert.equal(await fs.promises.readFile(path.join(snapshotDir, unknown), 'utf8'), jsonl(4, 'unknown'));
    const service = new SnapshotService(inventory);
    await assert.rejects(service.purgeTrash(profile.request, []), (error) => error.code === 'storage_degraded');
    const confirmed = await inventory.mutate(snapshotDir, (index) => inventory.acknowledgeRepair(index));
    assert.equal(confirmed.degraded, true);
    assert.equal(confirmed.destructiveBlocked, false);
    assert.deepEqual(await service.purgeTrash(profile.request, []), { purged: 0 });
});

test('前端捕获不拼 canonical key，业务调用只传服务端 opaque key', async () => {
    const contextSource = await fs.promises.readFile(
        path.join(__dirname, '../extensions/chat-sentinel-backup/src/chat-context.js'),
        'utf8',
    );
    const controllerSource = await fs.promises.readFile(
        path.join(__dirname, '../extensions/chat-sentinel-backup/src/controller.js'),
        'utf8',
    );
    const managerSource = await fs.promises.readFile(
        path.join(__dirname, '../extensions/chat-sentinel-backup/src/manager.js'),
        'utf8',
    );
    const serverControllerSource = await fs.promises.readFile(
        path.join(__dirname, '../plugins/chat-sentinel-backup/lib/controller.cjs'),
        'utf8',
    );
    assert.doesNotMatch(contextSource, /key:\s*`(?:char|group):/);
    assert.match(controllerSource, /identity\/resolve/);
    assert.match(controllerSource, /opaqueKey:\s*resolved\.opaqueKey/);
    assert.match(controllerSource, /event_types\.CHARACTER_RENAMED/);
    assert.match(controllerSource, /event_types\.CHAT_RENAMED/);
    assert.match(controllerSource, /identity\/character-renamed/);
    assert.match(controllerSource, /identity\/chat-renamed/);
    assert.match(serverControllerSource, /identity\/character-renamed/);
    assert.match(serverControllerSource, /identity\/chat-renamed/);
    assert.doesNotMatch(controllerSource, /chat-deleted'[\s\S]{0,180}captureCurrentChat/);
    assert.match(managerSource, /rollback === 'failed'/);
    assert.match(managerSource, /回滚未完整完成。请停止恢复、清理或删除操作/);
});

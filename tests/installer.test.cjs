const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { makeProfile } = require('./helpers.cjs');

async function makeOwnedInstall(profile, label) {
    const st = path.join(profile.root, label);
    const plugin = path.join(st, 'plugins', 'chat-sentinel-backup');
    const extension = path.join(st, 'data', 'default-user', 'extensions', 'chat-sentinel-backup');
    await fs.promises.mkdir(plugin, { recursive: true });
    await fs.promises.mkdir(extension, { recursive: true });
    await fs.promises.writeFile(path.join(st, 'server.js'), '// fixture\n');
    for (const target of [plugin, extension]) {
        await fs.promises.writeFile(
            path.join(target, '.chat-sentinel-backup-owner'),
            'chat-sentinel-backup-manual\n',
        );
        await fs.promises.writeFile(path.join(target, 'old-version.txt'), target);
    }
    return { st, plugin, extension };
}

test('installer 遇到未知目录时 fail closed', async (t) => {
    const profile = await makeProfile('installer');
    t.after(profile.cleanup);
    const st = path.join(profile.root, 'SillyTavern');
    const plugin = path.join(st, 'plugins', 'chat-sentinel-backup');
    const extensionRoot = path.join(st, 'data', 'default-user', 'extensions');
    await fs.promises.mkdir(plugin, { recursive: true });
    await fs.promises.mkdir(extensionRoot, { recursive: true });
    await fs.promises.writeFile(path.join(st, 'server.js'), '// fixture\n');
    await fs.promises.writeFile(path.join(plugin, 'keep-me.txt'), 'unknown owner\n');

    const result = spawnSync('zsh', ['scripts/install-current.command'], {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, SILLYTAVERN_DIR: st },
        encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /没有本插件所有权标记/);
    assert.equal(await fs.promises.readFile(path.join(plugin, 'keep-me.txt'), 'utf8'), 'unknown owner\n');
    assert.equal((await fs.promises.lstat(plugin)).isDirectory(), true);
});

test('installer 第二个链接切换失败会恢复前后端两个旧安装', async (t) => {
    const profile = await makeProfile('installer-rollback');
    t.after(profile.cleanup);
    const { st, plugin, extension } = await makeOwnedInstall(profile, 'SillyTavern');

    const result = spawnSync('zsh', ['scripts/install-current.command'], {
        cwd: path.resolve(__dirname, '..'),
        env: {
            ...process.env,
            SILLYTAVERN_DIR: st,
            SENTINEL_TEST_FAIL_SECOND_LINK: '1',
        },
        encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /本轮已变更的安装入口均已恢复/);
    assert.equal((await fs.promises.lstat(plugin)).isDirectory(), true);
    assert.equal((await fs.promises.lstat(extension)).isDirectory(), true);
    assert.equal(await fs.promises.readFile(path.join(plugin, 'old-version.txt'), 'utf8'), plugin);
    assert.equal(await fs.promises.readFile(path.join(extension, 'old-version.txt'), 'utf8'), extension);
});

test('installer 前端 backup mv 失败时保留前端 live 并恢复已备份的服务端', async (t) => {
    const profile = await makeProfile('installer-partial-backup');
    t.after(profile.cleanup);
    const { st, plugin, extension } = await makeOwnedInstall(profile, 'SillyTavern');

    const result = spawnSync('zsh', ['scripts/install-current.command'], {
        cwd: path.resolve(__dirname, '..'),
        env: {
            ...process.env,
            SILLYTAVERN_DIR: st,
            SENTINEL_TEST_FAIL_EXTENSION_BACKUP: '1',
        },
        encoding: 'utf8',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /前端旧安装备份失败/);
    assert.match(result.stderr, /本轮已变更的安装入口均已恢复/);
    assert.equal((await fs.promises.lstat(plugin)).isDirectory(), true);
    assert.equal((await fs.promises.lstat(extension)).isDirectory(), true);
    assert.equal(await fs.promises.readFile(path.join(plugin, 'old-version.txt'), 'utf8'), plugin);
    assert.equal(await fs.promises.readFile(path.join(extension, 'old-version.txt'), 'utf8'), extension);
});

test('installer 一个恢复动作失败时仍恢复另一个目标并聚合报告失败', async (t) => {
    const profile = await makeProfile('installer-rollback-aggregate');
    t.after(profile.cleanup);
    const { st, plugin, extension } = await makeOwnedInstall(profile, 'SillyTavern');

    const result = spawnSync('zsh', ['scripts/install-current.command'], {
        cwd: path.resolve(__dirname, '..'),
        env: {
            ...process.env,
            SILLYTAVERN_DIR: st,
            SENTINEL_TEST_FAIL_SECOND_LINK: '1',
            SENTINEL_TEST_FAIL_PLUGIN_RESTORE: '1',
        },
        encoding: 'utf8',
    });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /服务端恢复失败/);
    assert.match(result.stderr, /回滚有 1 项未完成/);
    assert.equal(await fs.promises.readFile(path.join(extension, 'old-version.txt'), 'utf8'), extension);
    assert.equal(await fs.promises.stat(plugin).then(() => true, () => false), false);
    const pluginParent = path.dirname(plugin);
    const backups = (await fs.promises.readdir(pluginParent))
        .filter((name) => name.startsWith('chat-sentinel-backup.bak-'));
    assert.equal(backups.length, 1);
    assert.equal(
        await fs.promises.readFile(path.join(pluginParent, backups[0], 'old-version.txt'), 'utf8'),
        plugin,
    );
});

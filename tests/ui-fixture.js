import { createManager } from '/src/manager.js';

const managerHtml = await fetch('/manager.html').then((response) => response.text());
document.getElementById('fixture').innerHTML = managerHtml;
const now = Date.now();
const currentChat = {
    opaqueKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    kind: 'char',
    entityId: 'candy.png',
    entityName: 'Candy',
    chatId: '海边散步',
    pathSemantic: 'chats/candy/海边散步.jsonl',
};
const versions = [
    { name: 'v3.jsonl', opaqueKey: currentChat.opaqueKey, messageCount: 186, size: 88200, mtimeMs: now - 180000, createdAt: new Date(now - 180000).toISOString(), kept: false, status: 'auto' },
    { name: 'v2.jsonl', opaqueKey: currentChat.opaqueKey, messageCount: 184, size: 86100, mtimeMs: now - 3600000, createdAt: new Date(now - 3600000).toISOString(), kept: true, status: 'manual' },
    { name: 'v1.jsonl', opaqueKey: currentChat.opaqueKey, messageCount: 179, size: 83000, mtimeMs: now - 86400000, createdAt: new Date(now - 86400000).toISOString(), kept: false, status: 'legacy' },
];
const secondChat = {
    opaqueKey: 'bbbbbbbbbbbbbbbbbbbbbbbb',
    kind: 'group',
    entityId: 'group-1',
    entityName: '夜航小组',
    chatId: '雨夜分支',
    snapshots: [
        { name: 'g1.jsonl', opaqueKey: 'bbbbbbbbbbbbbbbbbbbbbbbb', messageCount: 64, size: 31200, mtimeMs: now - 7200000, createdAt: new Date(now - 7200000).toISOString(), kept: false, status: 'auto' },
    ],
};
const trash = [{
    name: 'trash.jsonl',
    opaqueKey: currentChat.opaqueKey,
    messageCount: 170,
    size: 79000,
    trashedAt: new Date(now - 90000000).toISOString(),
    trashReason: 'version-deleted',
    chat: currentChat,
}];

const api = {
    async post(route, body = {}) {
        if (route === '/health') return { ok: true, healthy: true, directory: '/test-profile/backups/sentinel-chat', current: { identity: currentChat, versionCount: versions.length, latest: versions[0] } };
        if (route === '/history/current') return { identity: currentChat, snapshots: versions };
        if (route === '/history/all') return {
            groups: [{ ...currentChat, snapshots: versions }, secondChat],
            quarantine: [{
                name: '20260627-123456_char_旧备份_story_aaaaaaaaaaaaaaaa_m42.jsonl',
                reason: 'legacy_identity_unproven',
            }],
        };
        if (route === '/history/preview') return {
            name: body.name,
            messageCount: 186,
            messages: [
                { name: 'User', is_user: true, mes: '测试资料只存在临时 profile，不含真实聊天。' },
                { name: 'Candy', is_user: false, mes: '这个版本看起来完整，可以先长期保留。' },
            ],
        };
        if (route === '/trash/list') return { snapshots: trash, quarantine: [] };
        if (route === '/entity-chats') return { chats: [{ opaqueKey: currentChat.opaqueKey, name: '海边散步', messageCount: 186 }, { opaqueKey: secondChat.opaqueKey, name: 'Branch #1', messageCount: 83 }] };
        if (route === '/snapshot') return { skipped: false, messageCount: 186, file: 'fixture.jsonl' };
        if (route === '/snapshot-all') return { written: 2, total: 2, skipped: 0 };
        if (route === '/snapshot-selected') return { written: body.selectedOpaqueKeys.length, total: body.selectedOpaqueKeys.length, skipped: 0 };
        if (route === '/history/keep') {
            const item = versions.find((version) => version.name === body.name);
            if (item) item.kept = body.keep;
            return { changed: item ? 1 : 0 };
        }
        if (route === '/history/trash') return { changed: 1 };
        if (route === '/history/restore') return { restored: body.name, target: '海边散步.jsonl', preRestoreSnapshot: 'pre-restore-fixture.jsonl' };
        if (route === '/trash/restore') return { restored: 1 };
        if (route === '/trash/purge') return { purged: 1 };
        if (route === '/trash/restore-chat') return { restored: body.name, preRestoreSnapshot: 'pre-restore-fixture.jsonl' };
        if (route === '/maintenance/confirm-repair') return { storage: { degraded: true, destructiveBlocked: false } };
        throw new Error(`Unknown fixture route: ${route}`);
    },
};

const settings = { enabled: true, intervalSeconds: 20, keepPerChat: 80 };
const root = document.getElementById('chat_sentinel_manager');
const manager = createManager({
    root,
    api,
    getCurrentIdentity: async () => currentChat,
    getSettings: () => settings,
    updateSettings: (change) => Object.assign(settings, change),
    version: '2.0.0-test',
});
await manager.open(document.getElementById('fixture_opener'));
window.__sentinelFixtureReady = true;

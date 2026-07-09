const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const plugin = require(process.env.CHAT_SENTINEL_PLUGIN_PATH || '../plugins/chat-sentinel-backup/index.cjs');

function syntheticChat(messageCount) {
    const lines = [{ chat_metadata: {}, user_name: 'User', character_name: 'Character' }];
    for (let index = 0; index < messageCount; index += 1) {
        lines.push({ name: index % 2 ? 'Character' : 'User', is_user: index % 2 === 0, mes: `message-${index}` });
    }
    return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-sentinel-test-'));
    const directories = {
        backups: path.join(root, 'backups'),
        chats: path.join(root, 'chats'),
        groupChats: path.join(root, 'group-chats'),
        groups: path.join(root, 'groups'),
    };
    Object.values(directories).forEach((directory) => fs.mkdirSync(directory, { recursive: true }));

    const chatDir = path.join(directories.chats, 'Character');
    const chatPath = path.join(chatDir, 'chat-a.jsonl');
    fs.mkdirSync(chatDir, { recursive: true });
    fs.writeFileSync(chatPath, syntheticChat(100));

    const routes = new Map();
    await plugin.init({
        post(route, handler) {
            routes.set(route, handler);
        },
    });

    async function invoke(route, body) {
        let statusCode = 200;
        let payload;
        const response = {
            status(value) {
                statusCode = value;
                return this;
            },
            json(value) {
                payload = value;
                return value;
            },
        };
        await routes.get(route)({ body, user: { directories } }, response);
        return { statusCode, payload };
    }

    const identity = {
        isGroup: false,
        entityId: 'Character.png',
        entityName: 'Character',
        chatId: 'chat-a',
        keepPerChat: 8,
        chat: [{}, { mes: 'legacy frontend payload must be ignored' }],
    };

    const first = await invoke('/snapshot', identity);
    assert.equal(first.statusCode, 200);
    assert.equal(first.payload.messageCount, 100);
    assert.equal(first.payload.skipped, false);

    const duplicate = await invoke('/snapshot', identity);
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.payload.skipped, true);

    const snapshotDir = path.join(directories.backups, 'sentinel-chat');
    fs.writeFileSync(
        path.join(snapshotDir, `20990101-000000_char_Character_chat-a_${first.payload.keyHash}_m1.jsonl`),
        syntheticChat(1),
    );
    const snapshotCountBeforeRegression = fs.readdirSync(snapshotDir).filter((name) => name.endsWith('.jsonl')).length;

    fs.writeFileSync(chatPath, syntheticChat(1));
    const regression = await invoke('/snapshot', identity);
    assert.equal(regression.statusCode, 409);
    assert.equal(regression.payload.code, 'message_count_regression');
    assert.equal(regression.payload.currentMessageCount, 1);
    assert.equal(regression.payload.baselineMessageCount, 100);

    assert.equal(
        fs.readdirSync(snapshotDir).filter((name) => name.endsWith('.jsonl')).length,
        snapshotCountBeforeRegression,
    );

    fs.rmSync(root, { recursive: true, force: true });
    console.log('chat-sentinel smoke test passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

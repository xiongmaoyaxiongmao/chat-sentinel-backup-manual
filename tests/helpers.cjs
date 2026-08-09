const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function jsonl(messageCount, prefix = 'fixture') {
    const lines = [JSON.stringify({ user_name: 'Test User', character_name: 'Test Character' })];
    for (let index = 0; index < messageCount; index += 1) {
        lines.push(JSON.stringify({
            name: index % 2 ? 'Assistant' : 'User',
            is_user: index % 2 === 0,
            mes: `${prefix}-${index}`,
            send_date: `2026-07-30T00:00:${String(index % 60).padStart(2, '0')}Z`,
        }));
    }
    return `${lines.join('\n')}\n`;
}

async function makeProfile(label = 'profile') {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `sentinel-${label}-`));
    const directories = {
        backups: path.join(root, 'backups'),
        chats: path.join(root, 'chats'),
        groupChats: path.join(root, 'group-chats'),
        groups: path.join(root, 'groups'),
    };
    await Promise.all(Object.values(directories).map((directory) => fs.promises.mkdir(directory, { recursive: true })));
    return {
        root,
        request: { user: { directories } },
        directories,
        cleanup: () => fs.promises.rm(root, { recursive: true, force: true }),
    };
}

async function writeCharacterChat(profile, avatar, chatId, text) {
    const directory = path.join(profile.directories.chats, avatar.replace(/\.png$/i, ''));
    await fs.promises.mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `${chatId}.jsonl`);
    await fs.promises.writeFile(filePath, text, 'utf8');
    return filePath;
}

async function writeGroupChat(profile, groupId, chatId, text) {
    const filePath = path.join(profile.directories.groupChats, `${chatId}.jsonl`);
    await fs.promises.writeFile(filePath, text, 'utf8');
    await fs.promises.writeFile(
        path.join(profile.directories.groups, `${groupId}.json`),
        `${JSON.stringify({ id: groupId, name: 'Fixture Group', chats: [chatId], chat_id: chatId }, null, 2)}\n`,
        'utf8',
    );
    return filePath;
}

module.exports = { jsonl, makeProfile, writeCharacterChat, writeGroupChat };

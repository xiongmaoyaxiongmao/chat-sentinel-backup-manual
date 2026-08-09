const { createController } = require('./lib/controller.cjs');

const info = {
    id: 'chat_sentinel_backup',
    name: 'Chat Sentinel Backup',
    description: 'Reliable local per-chat JSONL snapshots and recovery.',
};

async function init(router) {
    createController().register(router);
}

module.exports = { info, init };

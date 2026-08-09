const { snapshotDirectory } = require('./identity.cjs');
const { InventoryOwner } = require('./inventory.cjs');
const { RecoveryService } = require('./recovery.cjs');
const { SnapshotService } = require('./snapshot-service.cjs');
const { KeyedTaskQueue } = require('./task-queue.cjs');

function sendError(response, error, operation) {
    console.error(`[chat-sentinel-backup] ${operation} failed:`, error);
    response.status(error.statusCode || 500).json({
        ok: false,
        code: error.code || 'operation_failed',
        error: error.message,
        rollback: error.rollback,
        ...(error.details || {}),
    });
}

function asyncRoute(operation, handler) {
    return async (request, response) => {
        try {
            const result = await handler(request, response);
            if (!response.headersSent) response.json({ ok: true, ...result });
        } catch (error) {
            sendError(response, error, operation);
        }
    };
}

function createController(options = {}) {
    const inventory = options.inventory || new InventoryOwner();
    const snapshots = options.snapshots || new SnapshotService(inventory);
    const recovery = options.recovery || new RecoveryService(inventory);
    const chatQueue = new KeyedTaskQueue();

    async function queuedSnapshot(request, body) {
        const opaqueKey = String(body.opaqueKey || '');
        return chatQueue.run(opaqueKey, () => snapshots.snapshot(request, body));
    }

    function register(router) {
        router.post('/identity/resolve', asyncRoute('identity-resolve', async (request) =>
            snapshots.registerIdentity(request, request.body || {})));

        router.post('/identity/deletion-lookup', asyncRoute('deletion-lookup', async (request) =>
            snapshots.deletionLookup(request, request.body || {})));

        router.post('/identity/character-renamed', asyncRoute('character-renamed', async (request) =>
            snapshots.remapCharacter(request, request.body || {})));

        router.post('/identity/chat-renamed', asyncRoute('chat-renamed', async (request) =>
            snapshots.remapChat(request, request.body || {})));

        router.post('/health', asyncRoute('health', async (request) => {
            const directory = snapshotDirectory(request);
            const storage = await inventory.health(directory);
            const result = {
                healthy: !storage.degraded,
                writable: !storage.lastWriteFailure,
                directory,
                version: 2,
                storage,
            };
            if (request.body?.opaqueKey) {
                const current = await snapshots.current(request, request.body);
                result.current = {
                    identity: current.identity,
                    versionCount: current.snapshots.length,
                    latest: current.snapshots[0] || null,
                };
            }
            return result;
        }));

        router.post('/snapshot', asyncRoute('snapshot', async (request) =>
            queuedSnapshot(request, request.body || {})));

        router.post('/entity-chats', asyncRoute('entity-chats', async (request) => {
            const chats = await snapshots.entityChats(request, request.body || {});
            return { total: chats.length, chats };
        }));

        router.post('/snapshot-all', asyncRoute('snapshot-all', async (request) =>
            snapshots.snapshotMany(request, request.body || {})));

        router.post('/snapshot-selected', asyncRoute('snapshot-selected', async (request) => {
            const body = request.body || {};
            const selected = Array.isArray(body.selectedOpaqueKeys) ? body.selectedOpaqueKeys : [];
            if (selected.length === 0) {
                const error = new Error('请先选择聊天');
                error.statusCode = 400;
                throw error;
            }
            return snapshots.snapshotMany(request, body, selected);
        }));

        router.post('/history/current', asyncRoute('history-current', async (request) =>
            snapshots.current(request, request.body || {})));

        router.post('/history/all', asyncRoute('history-all', async (request) =>
            snapshots.history(request)));

        router.post('/history/keep', asyncRoute('history-keep', async (request) =>
            snapshots.setKept(request, request.body || {}, request.body?.keep !== false)));

        router.post('/history/trash', asyncRoute('history-trash', async (request) =>
            snapshots.moveToTrash(request, request.body || {})));

        router.post('/history/preview', asyncRoute('history-preview', async (request) =>
            snapshots.preview(request, request.body || {})));

        router.post('/history/restore', asyncRoute('history-restore', async (request) =>
            recovery.restore(request, request.body || {})));

        router.post('/trash/list', asyncRoute('trash-list', async (request) =>
            snapshots.trash(request)));

        router.post('/trash/restore', asyncRoute('trash-restore', async (request) =>
            snapshots.restoreTrash(request, request.body?.selected)));

        router.post('/trash/purge', asyncRoute('trash-purge', async (request) =>
            snapshots.purgeTrash(request, request.body?.selected)));

        router.post('/trash/restore-chat', asyncRoute('trash-restore-chat', async (request) =>
            recovery.restoreDeleted(request, request.body?.name)));

        router.post('/chat-deleted', asyncRoute('chat-deleted', async (request) =>
            snapshots.markChatDeleted(request, request.body || {})));

        router.post('/maintenance/confirm-repair', asyncRoute('confirm-repair', async (request) => {
            if (request.body?.confirm !== true) {
                const error = new Error('需要明确确认后才能解除修复锁');
                error.statusCode = 400;
                throw error;
            }
            const directory = snapshotDirectory(request);
            const storage = await inventory.mutate(directory, (index) => inventory.acknowledgeRepair(index));
            return { storage };
        }));
    }

    return { register, inventory, snapshots, recovery };
}

module.exports = { asyncRoute, createController, sendError };

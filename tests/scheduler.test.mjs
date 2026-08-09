import assert from 'node:assert/strict';
import test from 'node:test';
import { PerChatSnapshotScheduler } from '../extensions/chat-sentinel-backup/src/snapshot-scheduler.js';

function captured(key, chatId) {
    return { key, payload: { chatId, entityId: `${chatId}.png`, entityName: chatId, isGroup: false } };
}

test('A/B 快速切换会分别保存冻结的目标', async () => {
    const calls = [];
    const scheduler = new PerChatSnapshotScheduler({
        intervalMs: () => 0,
        run: async ({ payload }) => calls.push(payload.chatId),
    });
    scheduler.schedule(captured('a', 'A'), 'message');
    scheduler.schedule(captured('b', 'B'), 'message');
    await new Promise((resolve) => setTimeout(resolve, 1250));
    assert.deepEqual(calls.sort(), ['A', 'B']);
});

test('同聊天执行中再次变化会在完成后补跑', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const calls = [];
    const scheduler = new PerChatSnapshotScheduler({
        intervalMs: () => 0,
        run: async ({ reason }) => {
            calls.push(reason);
            if (calls.length === 1) await gate;
        },
    });
    const target = captured('a', 'A');
    scheduler.schedule(target, 'first');
    await new Promise((resolve) => setTimeout(resolve, 1250));
    scheduler.schedule(target, 'second');
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(calls, ['first', 'second']);
});

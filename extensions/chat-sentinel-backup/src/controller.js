import {
    eventSource,
    event_types,
    getRequestHeaders,
    saveSettingsDebounced,
} from '../../../../../script.js';
import {
    extension_settings,
    renderExtensionTemplateAsync,
} from '../../../../extensions.js';
import { compressRequest } from '../../../../request-compression.js';
import { SentinelApi } from './api-client.js';
import { captureCurrentChat } from './chat-context.js';
import { createManager } from './manager.js';
import { PerChatSnapshotScheduler } from './snapshot-scheduler.js';

const MODULE_NAME = 'chat-sentinel-backup';
const VERSION = '3.0.0';
const DEFAULT_SETTINGS = {
    enabled: true,
    intervalSeconds: 20,
};

function clamp(value, minimum, maximum, fallback) {
    const number = Number(value);
    return Number.isFinite(number)
        ? Math.min(maximum, Math.max(minimum, Math.round(number)))
        : fallback;
}

function settings() {
    extension_settings[MODULE_NAME] ||= { ...DEFAULT_SETTINGS };
    const value = extension_settings[MODULE_NAME];
    value.enabled = value.enabled ?? true;
    value.intervalSeconds = clamp(value.intervalSeconds, 5, 300, 20);
    return value;
}

function updateSettings(change) {
    Object.assign(settings(), change);
    settings().intervalSeconds = clamp(settings().intervalSeconds, 5, 300, 20);
    saveSettingsDebounced();
}

function setEntryStatus(message, healthy = true) {
    const status = document.getElementById('chat_sentinel_entry_status');
    const dot = document.getElementById('chat_sentinel_health_dot');
    if (status) status.textContent = message;
    if (dot) dot.classList.toggle('is_unhealthy', !healthy);
}

export async function initializeSentinel() {
    settings();
    const api = new SentinelApi({ getHeaders: getRequestHeaders, compressRequest });
    const [settingsHtml, managerHtml] = await Promise.all([
        renderExtensionTemplateAsync(`third-party/${MODULE_NAME}`, 'settings'),
        renderExtensionTemplateAsync(`third-party/${MODULE_NAME}`, 'manager'),
    ]);
    $('#extensions_settings').append(settingsHtml);
    document.body.insertAdjacentHTML('beforeend', managerHtml);
    const managerRoot = document.getElementById('chat_sentinel_manager');
    const manager = createManager({
        root: managerRoot,
        api,
        getCurrentIdentity: async () => {
            const captured = captureCurrentChat('manual');
            const resolved = await api.post('/identity/resolve', captured);
            return { ...resolved.identity, opaqueKey: resolved.opaqueKey };
        },
        getSettings: settings,
        updateSettings,
        version: VERSION,
    });

    const scheduler = new PerChatSnapshotScheduler({
        intervalMs: () => settings().intervalSeconds * 1000,
        run: ({ payload }) => api.post('/snapshot', {
            ...payload,
        }),
        onResult: (_job, result) => {
            setEntryStatus(result.skipped ? '自动守护正常，内容没有变化。' : `自动守护正常，已滚动保护 ${result.messageCount} 条。`);
            manager.notify(result.skipped ? '内容没有变化，现有保护点仍有效。' : `已更新循环保护点（${result.slot + 1}/10）。`, 'success');
        },
        onError: (_job, error) => {
            if (error.code === 'message_count_regression') {
                setEntryStatus(`已拦截异常缩水：${error.details.baselineMessageCount} → ${error.details.currentMessageCount} 条。`, false);
                manager.notify(`已拦截异常缩水：基线 ${error.details.baselineMessageCount} 条，当前 ${error.details.currentMessageCount} 条。请在“立即保护当前聊天”中人工确认。`, 'danger');
            } else {
                setEntryStatus(`自动守护失败：${error.message}`, false);
            }
        },
    });

    const eventNames = [
        event_types.MESSAGE_SENT,
        event_types.MESSAGE_RECEIVED,
        event_types.MESSAGE_UPDATED,
        event_types.MESSAGE_DELETED,
        event_types.MESSAGES_DELETED,
        event_types.MESSAGE_SWIPED,
        event_types.GENERATION_ENDED,
        event_types.MESSAGE_REASONING_EDITED,
        event_types.MESSAGE_REASONING_DELETED,
        event_types.MESSAGE_FILE_EMBEDDED,
    ].filter(Boolean);
    for (const eventName of eventNames) {
        eventSource.on(eventName, async () => {
            if (!settings().enabled) return;
            try {
                const captured = captureCurrentChat(eventName);
                const resolved = await api.post('/identity/resolve', captured);
                scheduler.schedule({
                    key: resolved.opaqueKey,
                    payload: { opaqueKey: resolved.opaqueKey, reason: eventName },
                }, eventName);
            } catch {}
        });
    }

    async function markDeleted(chatId, isGroup) {
        try {
            const lookup = await api.post('/identity/deletion-lookup', {
                kind: isGroup ? 'group' : 'char',
                chatId: String(chatId || '').replace(/\.jsonl$/i, ''),
            });
            if (lookup.pending) {
                setEntryStatus('删除事件缺少唯一角色归属，已停止移动快照并登记待核对项。', false);
                return;
            }
            await api.post('/chat-deleted', { opaqueKey: lookup.opaqueKey });
            setEntryStatus('已把删除聊天的守护版本放入回收站。');
        } catch (error) {
            setEntryStatus(`回收站标记失败：${error.message}`, false);
        }
    }
    if (event_types.CHAT_DELETED) {
        eventSource.on(event_types.CHAT_DELETED, (chatId) => markDeleted(chatId, false));
    }
    if (event_types.GROUP_CHAT_DELETED) {
        eventSource.on(event_types.GROUP_CHAT_DELETED, (chatId) => markDeleted(chatId, true));
    }

    async function remapCharacter(oldAvatar, newAvatar) {
        try {
            const result = await api.post('/identity/character-renamed', { oldAvatar, newAvatar });
            if (result.remapped) setEntryStatus(`已随角色改名更新 ${result.remapped} 个守护聊天。`);
        } catch (error) {
            setEntryStatus(`角色改名后的守护身份未更新：${error.message}`, false);
        }
    }

    async function remapChat({ avatarId, groupId, oldFileName, newFileName } = {}) {
        try {
            const result = await api.post('/identity/chat-renamed', {
                isGroup: Boolean(groupId),
                entityId: groupId || avatarId,
                oldFileName,
                newFileName,
            });
            if (result.remapped) setEntryStatus('已随聊天改名更新守护身份。');
        } catch (error) {
            setEntryStatus(`聊天改名后的守护身份未更新：${error.message}`, false);
        }
    }
    if (event_types.CHARACTER_RENAMED) {
        eventSource.on(event_types.CHARACTER_RENAMED, remapCharacter);
    }
    if (event_types.CHAT_RENAMED) {
        eventSource.on(event_types.CHAT_RENAMED, remapChat);
    }

    document.getElementById('chat_sentinel_open_manager').addEventListener('click', (event) => manager.open(event.currentTarget));
    try {
        const health = await api.post('/health');
        setEntryStatus(health.healthy ? '本地存储正常。' : '本地存储需要检查。', health.healthy);
    } catch (error) {
        setEntryStatus(`本地服务不可用：${error.message}`, false);
    }
}

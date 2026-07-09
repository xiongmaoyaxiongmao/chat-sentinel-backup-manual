import {
    characters,
    eventSource,
    event_types,
    getCurrentChatId,
    getRequestHeaders,
    name2,
    saveSettingsDebounced,
    this_chid,
} from '../../../../script.js';

import {
    groups,
    selected_group,
} from '../../../group-chats.js';

import {
    extension_settings,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';

import { compressRequest } from '../../../request-compression.js';

const MODULE_NAME = 'chat-sentinel-backup';
const API_BASE = '/api/plugins/chat_sentinel_backup';
const DEFAULT_SETTINGS = {
    enabled: true,
    intervalSeconds: 20,
    keepPerChat: 80,
};

let initialized = false;
let pendingTimer = null;
let saving = false;
let lastSnapshotAt = 0;
let lastStatus = '等待第一次备份。';
let pickerLoadedFor = '';
let versionsLoadedFor = '';
let deletedLoaded = false;

function settings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }

    const current = extension_settings[MODULE_NAME];
    current.enabled = current.enabled ?? DEFAULT_SETTINGS.enabled;
    current.intervalSeconds = clampNumber(current.intervalSeconds, 5, 300, DEFAULT_SETTINGS.intervalSeconds);
    current.keepPerChat = clampNumber(current.keepPerChat, 5, 500, DEFAULT_SETTINGS.keepPerChat);
    return current;
}

function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(number)));
}

function currentEntity() {
    const activeChatId = getCurrentChatId();

    if (selected_group) {
        const group = groups.find((item) => item.id === selected_group);
        return {
            isGroup: true,
            entityId: selected_group,
            entityName: group?.name || 'group',
            chatId: activeChatId || group?.chat_id,
            groupChatIds: Array.isArray(group?.chats) ? [...group.chats] : [],
        };
    }

    const character = this_chid !== undefined ? characters[this_chid] : null;
    return {
        isGroup: false,
        entityId: character?.avatar || '',
        entityName: character?.name || name2 || 'character',
        chatId: activeChatId || character?.chat,
    };
}

function requireDirectoryEntity(entity = currentEntity()) {
    if (!entity.isGroup && !entity.entityId) {
        throw new Error('请先打开一个角色聊天。');
    }
    if (entity.isGroup && !entity.entityId) {
        throw new Error('请先打开一个群聊。');
    }
    return entity;
}

function buildSnapshotPayload(reason) {
    const entity = currentEntity();
    const chatId = entity.chatId || getCurrentChatId();

    if (!chatId) {
        throw new Error('当前没有可备份的聊天文件。');
    }

    return {
        ...entity,
        chatId,
        reason,
        keepPerChat: settings().keepPerChat,
    };
}

async function postJson(path, body) {
    const request = await compressRequest({
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
        cache: 'no-cache',
    });

    const response = await fetch(`${API_BASE}${path}`, request);
    const data = await response.json().catch(() => ({}));

    if (!response.ok || data?.ok === false) {
        const error = new Error(data?.error || response.statusText || '请求失败');
        error.code = data?.code || '';
        error.details = data;
        throw error;
    }

    return data;
}

function setStatus(message, isError = false) {
    lastStatus = message;
    const element = document.getElementById('chat_sentinel_status');
    if (element) {
        element.textContent = message;
        element.classList.toggle('warning', isError);
    }
}

async function runSnapshot(reason = 'manual') {
    const currentSettings = settings();
    if (!currentSettings.enabled && reason !== 'manual') {
        return;
    }

    if (saving) {
        scheduleSnapshot(reason);
        return;
    }

    saving = true;
    try {
        const payload = buildSnapshotPayload(reason);
        const result = await postJson('/snapshot', payload);
        lastSnapshotAt = Date.now();

        if (result.skipped) {
            setStatus('没有变化，已跳过重复快照。');
        } else {
            setStatus(`已备份当前聊天，${result.messageCount} 条消息。`);
        }

        await refreshList(false);
    } catch (error) {
        console.error('[chat-sentinel-backup] backup failed:', error);
        setStatus(`备份失败：${error.message}`, true);
        if (reason === 'manual') {
            toastr.error(error.message, '聊天记录守护备份');
        }
    } finally {
        saving = false;
    }
}

async function runEntitySnapshot() {
    const currentSettings = settings();
    if (saving) {
        setStatus('已有备份正在进行，稍后再试。');
        return;
    }

    saving = true;
    try {
        const payload = {
            ...requireDirectoryEntity(),
            reason: 'manual-all',
            keepPerChat: currentSettings.keepPerChat,
        };
        const result = await postJson('/snapshot-all', payload);
        const skippedText = result.skipped ? `，跳过 ${result.skipped} 个空文件或异常文件` : '';
        setStatus(`已备份当前${payload.isGroup ? '群聊' : '角色卡'}：${result.written}/${result.total}${skippedText}。`);
        toastr.success(`已备份 ${result.written} 个聊天文件`, '聊天记录守护备份');
        await refreshList(false);
    } catch (error) {
        console.error('[chat-sentinel-backup] bulk backup failed:', error);
        setStatus(`全量备份失败：${error.message}`, true);
        toastr.error(error.message, '聊天记录守护备份');
    } finally {
        saving = false;
    }
}

function entityPickerKey(entity = currentEntity()) {
    return `${entity.isGroup ? 'group' : 'char'}:${entity.entityId || ''}`;
}

function currentVersionPayload() {
    const entity = currentEntity();
    return {
        ...entity,
        chatId: entity.chatId || getCurrentChatId(),
    };
}

function versionPickerKey(entity = currentVersionPayload()) {
    return `${entity.isGroup ? 'group' : 'char'}:${entity.entityId || ''}:${entity.chatId || ''}`;
}

function formatBytes(bytes) {
    const size = Number(bytes) || 0;
    if (size >= 1024 * 1024) {
        return `${(size / 1024 / 1024).toFixed(1)} MB`;
    }
    return `${Math.ceil(size / 1024)} KB`;
}

function formatDateTime(mtimeMs) {
    const date = new Date(Number(mtimeMs) || 0);
    if (Number.isNaN(date.getTime())) {
        return '';
    }
    return date.toLocaleString();
}

function formatShortTime(mtimeMs) {
    const date = new Date(Number(mtimeMs) || 0);
    if (Number.isNaN(date.getTime())) {
        return '';
    }
    return date.toLocaleString([], {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function displaySnapshotName(name) {
    return String(name || '')
        .replace(/^\d{8}-\d{6}_(char|group)_/, '')
        .replace(/_[a-f0-9]{16}(?:_KEEP)?_m\d+\.jsonl$/, '')
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || name;
}

function setEmptyText(element, text) {
    element.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'chat_sentinel_empty';
    empty.textContent = text;
    element.append(empty);
}

function renderVersions(snapshots) {
    const list = document.getElementById('chat_sentinel_versions_list');
    if (!list) {
        return;
    }

    list.innerHTML = '';
    clearVersionPreview();
    if (!snapshots?.length) {
        setEmptyText(list, '当前聊天还没有守护快照。');
        return;
    }

    for (const item of snapshots) {
        const label = document.createElement('label');
        label.className = 'chat_sentinel_pick_item chat_sentinel_version_item';
        label.title = item.name;

        if (item.kept) {
            label.classList.add('chat_sentinel_kept');
        }

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'chat_sentinel_version_checkbox';
        checkbox.value = item.name;

        const text = document.createElement('span');
        text.className = 'chat_sentinel_pick_name';
        text.textContent = displaySnapshotName(item.name);

        const meta = document.createElement('span');
        meta.className = 'chat_sentinel_pick_meta';
        const keepText = item.kept ? 'KEEP · ' : '';
        const messageText = item.messageCount === null ? '' : `${item.messageCount} 条 · `;
        meta.textContent = `${keepText}${messageText}${formatBytes(item.size)} · ${formatDateTime(item.mtimeMs)}`;

        label.append(checkbox, text, meta);
        list.append(label);
    }
}

function selectedVersionNames() {
    return Array.from(document.querySelectorAll('.chat_sentinel_version_checkbox:checked')).map((item) => item.value);
}

function clearVersionPreview(message = '') {
    const preview = document.getElementById('chat_sentinel_version_preview');
    if (!preview) {
        return;
    }

    preview.innerHTML = '';
    preview.hidden = !message;
    if (message) {
        const empty = document.createElement('div');
        empty.className = 'chat_sentinel_empty';
        empty.textContent = message;
        preview.append(empty);
    }
}

function renderVersionPreview(result) {
    const preview = document.getElementById('chat_sentinel_version_preview');
    if (!preview) {
        return;
    }

    preview.innerHTML = '';
    preview.hidden = false;

    const title = document.createElement('div');
    title.className = 'chat_sentinel_preview_title';
    title.textContent = `${displaySnapshotName(result.name)} · 共 ${result.messageCount} 条 · 显示最后 2 轮`;
    preview.append(title);

    if (!result.messages?.length) {
        setEmptyText(preview, '这个快照里没有可预览的消息。');
        return;
    }

    for (const message of result.messages) {
        const item = document.createElement('div');
        item.className = `chat_sentinel_preview_message ${message.is_user ? 'is_user' : 'is_reply'}`;

        const byline = document.createElement('div');
        byline.className = 'chat_sentinel_preview_byline';
        byline.textContent = message.name || (message.is_user ? 'User' : 'Assistant');

        const text = document.createElement('div');
        text.className = 'chat_sentinel_preview_text';
        text.textContent = message.mes || '';

        item.append(byline, text);
        preview.append(item);
    }
}

async function loadVersions(force = false) {
    const panel = document.getElementById('chat_sentinel_versions');
    const list = document.getElementById('chat_sentinel_versions_list');
    if (!panel || !list) {
        return;
    }

    const payload = currentVersionPayload();
    const key = versionPickerKey(payload);
    panel.hidden = false;

    if (!force && versionsLoadedFor === key && list.children.length > 0) {
        return;
    }

    try {
        list.textContent = '正在读取当前聊天的快照版本...';
        const result = await postJson('/versions', { ...payload, limit: 200 });
        versionsLoadedFor = key;
        renderVersions(result.snapshots);
        setStatus(`已读取当前聊天 ${result.snapshots.length} 个快照版本。`);
    } catch (error) {
        console.error('[chat-sentinel-backup] versions load failed:', error);
        list.textContent = `读取失败：${error.message}`;
        setStatus(`读取快照版本失败：${error.message}`, true);
    }
}

async function setSelectedVersionsKept(keep) {
    const selected = selectedVersionNames();
    if (selected.length === 0) {
        setStatus('还没有勾选要处理的快照版本。', true);
        toastr.warning('请先勾选快照版本', '聊天记录守护备份');
        return;
    }

    try {
        const payload = {
            ...currentVersionPayload(),
            selected,
            keep,
            limit: 200,
        };
        const result = await postJson('/versions/keep', payload);
        renderVersions(result.snapshots);
        const actionText = keep ? '保留' : '取消保留';
        setStatus(`已${actionText} ${result.changed} 个快照版本。`);
        toastr.success(`已${actionText} ${result.changed} 个版本`, '聊天记录守护备份');
        await refreshList(false);
    } catch (error) {
        console.error('[chat-sentinel-backup] version keep failed:', error);
        setStatus(`处理快照版本失败：${error.message}`, true);
        toastr.error(error.message, '聊天记录守护备份');
    }
}

async function previewSelectedVersion(showWarning = true) {
    const selected = selectedVersionNames();
    if (selected.length === 0) {
        clearVersionPreview('先勾选一个快照，再查看里面的最后两轮。');
        if (showWarning) {
            setStatus('还没有勾选要查看的快照版本。', true);
        }
        return;
    }

    try {
        const result = await postJson('/versions/preview', {
            ...currentVersionPayload(),
            name: selected[0],
            rounds: 2,
        });
        renderVersionPreview(result);
        setStatus(selected.length > 1 ? '已显示第一个已选快照的最后两轮。' : '已显示快照最后两轮。');
    } catch (error) {
        console.error('[chat-sentinel-backup] version preview failed:', error);
        clearVersionPreview(`读取快照内容失败：${error.message}`);
        setStatus(`读取快照内容失败：${error.message}`, true);
    }
}

async function deleteSelectedVersions() {
    const selected = selectedVersionNames();
    if (selected.length === 0) {
        setStatus('还没有勾选要删除的快照版本。', true);
        toastr.warning('请先勾选快照版本', '聊天记录守护备份');
        return;
    }

    if (!window.confirm(`删除 ${selected.length} 个守护快照？这不会删除 SillyTavern 当前聊天。`)) {
        return;
    }

    try {
        const result = await postJson('/versions/delete', {
            ...currentVersionPayload(),
            selected,
            limit: 200,
        });
        renderVersions(result.snapshots);
        setStatus(`已删除 ${result.deleted} 个快照版本。`);
        toastr.success(`已删除 ${result.deleted} 个版本`, '聊天记录守护备份');
        await refreshList(false);
    } catch (error) {
        console.error('[chat-sentinel-backup] version delete failed:', error);
        setStatus(`删除快照版本失败：${error.message}`, true);
        toastr.error(error.message, '聊天记录守护备份');
    }
}

async function restoreSelectedVersion() {
    const selected = selectedVersionNames();
    if (selected.length !== 1) {
        setStatus('覆盖当前聊天时只能勾选一个快照。', true);
        toastr.warning('请只勾选一个快照版本', '聊天记录守护备份');
        return;
    }

    const ok = window.confirm('用这个快照覆盖当前聊天文件？当前聊天会变成该快照内容。覆盖后请刷新或重新打开这个聊天。');
    if (!ok) {
        return;
    }

    try {
        const result = await postJson('/versions/restore', {
            ...currentVersionPayload(),
            name: selected[0],
        });
        setStatus(`已用快照覆盖当前聊天文件：${result.target}。请刷新或重新打开这个聊天。`);
        toastr.success('已覆盖当前聊天文件，请重新打开聊天查看', '聊天记录守护备份');
        await loadVersions(true);
        await refreshList(false);
    } catch (error) {
        console.error('[chat-sentinel-backup] version restore failed:', error);
        setStatus(`覆盖当前聊天失败：${error.message}`, true);
        toastr.error(error.message, '聊天记录守护备份');
    }
}

function deletedChatTitle(item) {
    const name = item.entityName || (item.isGroup ? '群聊' : '角色');
    const chatId = item.chatId || 'unknown';
    return `${name} / ${chatId}`;
}

function renderDeletedChats(chats) {
    const list = document.getElementById('chat_sentinel_deleted_list');
    if (!list) {
        return;
    }

    list.innerHTML = '';
    if (!chats?.length) {
        setEmptyText(list, '没有已删除聊天的守护快照。');
        return;
    }

    for (const item of chats) {
        const label = document.createElement('label');
        label.className = 'chat_sentinel_pick_item chat_sentinel_deleted_item';
        label.title = deletedChatTitle(item);

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'chat_sentinel_deleted_checkbox';
        checkbox.value = item.keyHash;

        const text = document.createElement('span');
        text.className = 'chat_sentinel_pick_name';
        text.textContent = deletedChatTitle(item);

        const meta = document.createElement('span');
        meta.className = 'chat_sentinel_pick_meta';
        const latest = item.latest || {};
        const messageText = latest.messageCount === null || latest.messageCount === undefined ? '' : `${latest.messageCount} 条 · `;
        const deletedAt = item.deletedAt ? ` · 删除于 ${formatShortTime(Date.parse(item.deletedAt))}` : '';
        meta.textContent = `${item.snapshotCount || 0} 份 · 最新 ${messageText}${formatBytes(latest.size)} · ${formatShortTime(latest.mtimeMs)}${deletedAt}`;

        label.append(checkbox, text, meta);
        list.append(label);
    }
}

function selectedDeletedKeys() {
    return Array.from(document.querySelectorAll('.chat_sentinel_deleted_checkbox:checked')).map((item) => item.value);
}

async function loadDeletedChats(force = false) {
    const panel = document.getElementById('chat_sentinel_deleted');
    const list = document.getElementById('chat_sentinel_deleted_list');
    if (!panel || !list) {
        return;
    }

    panel.hidden = false;
    if (!force && deletedLoaded && list.children.length > 0) {
        return;
    }

    try {
        list.textContent = '正在读取已删除聊天快照...';
        const result = await postJson('/deleted/list', { limit: 200 });
        deletedLoaded = true;
        renderDeletedChats(result.chats);
        setStatus(`已读取 ${result.total} 个已删除聊天快照组。`);
    } catch (error) {
        console.error('[chat-sentinel-backup] deleted list failed:', error);
        list.textContent = `读取失败：${error.message}`;
        setStatus(`读取已删除快照失败：${error.message}`, true);
    }
}

async function restoreSelectedDeletedChat() {
    const selected = selectedDeletedKeys();
    if (selected.length !== 1) {
        setStatus('恢复已删除聊天时只能勾选一个快照组。', true);
        toastr.warning('请只勾选一个已删除聊天', '聊天记录守护备份');
        return;
    }

    if (!window.confirm('把这个已删除聊天的最新守护快照恢复回原聊天文件？恢复后请刷新或重新打开聊天列表。')) {
        return;
    }

    try {
        const result = await postJson('/deleted/restore', {
            keyHash: selected[0],
            limit: 200,
        });
        renderDeletedChats(result.chats);
        setStatus(`已恢复已删除聊天：${result.target}。请刷新或重新打开聊天列表。`);
        toastr.success('已恢复聊天文件，请刷新或重新打开聊天列表', '聊天记录守护备份');
        await refreshList(false);
    } catch (error) {
        console.error('[chat-sentinel-backup] deleted restore failed:', error);
        setStatus(`恢复已删除聊天失败：${error.message}`, true);
        toastr.error(error.message, '聊天记录守护备份');
    }
}

async function purgeSelectedDeletedChats() {
    const selected = selectedDeletedKeys();
    if (selected.length === 0) {
        setStatus('还没有勾选要永久删除的快照组。', true);
        toastr.warning('请先勾选已删除聊天', '聊天记录守护备份');
        return;
    }

    if (!window.confirm(`永久删除 ${selected.length} 个已删除聊天的全部守护快照？这个操作不能撤销。`)) {
        return;
    }

    try {
        const result = await postJson('/deleted/purge', {
            selected,
            limit: 200,
        });
        renderDeletedChats(result.chats);
        setStatus(`已永久删除 ${result.deletedChats} 个聊天的 ${result.deletedFiles} 个守护快照。`);
        toastr.success(`已永久删除 ${result.deletedFiles} 个快照`, '聊天记录守护备份');
        await refreshList(false);
    } catch (error) {
        console.error('[chat-sentinel-backup] deleted purge failed:', error);
        setStatus(`永久删除已删除快照失败：${error.message}`, true);
        toastr.error(error.message, '聊天记录守护备份');
    }
}

function renderPicker(chats) {
    const list = document.getElementById('chat_sentinel_picker_list');
    if (!list) {
        return;
    }

    list.innerHTML = '';
    if (!chats?.length) {
        setEmptyText(list, '当前角色卡或群聊没有可选择的聊天。');
        return;
    }

    for (const item of chats) {
        const label = document.createElement('label');
        label.className = 'chat_sentinel_pick_item';
        label.title = item.name;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'chat_sentinel_pick_checkbox';
        checkbox.value = item.id;

        const text = document.createElement('span');
        text.className = 'chat_sentinel_pick_name';
        text.textContent = item.name;

        const meta = document.createElement('span');
        meta.className = 'chat_sentinel_pick_meta';
        meta.textContent = `${item.messageCount} 条 · ${formatBytes(item.size)} · ${formatDateTime(item.mtimeMs)}`;

        label.append(checkbox, text, meta);
        list.append(label);
    }
}

async function loadPicker(force = false) {
    const picker = document.getElementById('chat_sentinel_picker');
    const list = document.getElementById('chat_sentinel_picker_list');
    if (!picker || !list) {
        return;
    }

    picker.hidden = false;

    try {
        const entity = requireDirectoryEntity();
        const key = entityPickerKey(entity);
        if (!force && pickerLoadedFor === key && list.children.length > 0) {
            return;
        }

        list.textContent = '正在读取聊天列表...';
        const result = await postJson('/entity-chats', entity);
        pickerLoadedFor = key;
        renderPicker(result.chats);
        setStatus(`已读取 ${result.total} 个聊天文件，可勾选后备份。`);
    } catch (error) {
        console.error('[chat-sentinel-backup] picker load failed:', error);
        list.textContent = `读取失败：${error.message}`;
        setStatus(error.message, true);
    }
}

async function runSelectedSnapshot() {
    const selected = Array.from(document.querySelectorAll('.chat_sentinel_pick_checkbox:checked')).map((item) => item.value);
    if (selected.length === 0) {
        setStatus('还没有勾选要备份的聊天。', true);
        toastr.warning('请先勾选聊天', '聊天记录守护备份');
        return;
    }

    const currentSettings = settings();
    if (saving) {
        setStatus('已有备份正在进行，稍后再试。');
        return;
    }

    saving = true;
    try {
        const payload = {
            ...requireDirectoryEntity(),
            reason: 'manual-selected',
            keepPerChat: currentSettings.keepPerChat,
            selected,
        };
        const result = await postJson('/snapshot-selected', payload);
        const skippedText = result.skipped ? `，跳过 ${result.skipped} 个` : '';
        setStatus(`已备份已选聊天：${result.written}/${result.total}${skippedText}。`);
        toastr.success(`已备份 ${result.written} 个已选聊天`, '聊天记录守护备份');
        await refreshList(false);
    } catch (error) {
        console.error('[chat-sentinel-backup] selected backup failed:', error);
        setStatus(`备份已选失败：${error.message}`, true);
        toastr.error(error.message, '聊天记录守护备份');
    } finally {
        saving = false;
    }
}

async function markDeletedChat(chatId, isGroup) {
    const normalizedChatId = String(chatId || '').replace(/\.jsonl$/i, '');
    if (!normalizedChatId) {
        return;
    }

    try {
        const entity = currentEntity();
        const payload = {
            ...entity,
            isGroup,
            chatId: normalizedChatId,
        };

        if (isGroup) {
            payload.entityId = selected_group || entity.entityId;
            payload.entityName = groups.find((item) => item.id === payload.entityId)?.name || entity.entityName || 'group';
        }

        await postJson('/deleted/mark', payload);
        deletedLoaded = false;
        setStatus(`已隐藏已删除聊天的守护快照：${normalizedChatId}。`);
        await refreshList(false);

        const deletedPanel = document.getElementById('chat_sentinel_deleted');
        if (deletedPanel && !deletedPanel.hidden) {
            await loadDeletedChats(true);
        }
    } catch (error) {
        console.error('[chat-sentinel-backup] deleted mark failed:', error);
        setStatus(`标记已删除聊天失败：${error.message}`, true);
    }
}

function scheduleSnapshot(reason) {
    const currentSettings = settings();
    if (!currentSettings.enabled) {
        return;
    }

    clearTimeout(pendingTimer);
    const elapsed = Date.now() - lastSnapshotAt;
    const intervalMs = currentSettings.intervalSeconds * 1000;
    const delay = Math.max(1200, intervalMs - elapsed);

    pendingTimer = setTimeout(() => {
        pendingTimer = null;
        runSnapshot(reason);
    }, delay);
}

async function refreshList(showToast = true) {
    const list = document.getElementById('chat_sentinel_list');
    if (!list) {
        return;
    }

    try {
        const result = await postJson('/list', { limit: 20 });
        list.innerHTML = '';

        if (!result.snapshots?.length) {
            setEmptyText(list, '暂无守护快照。');
        } else {
            for (const snapshot of result.snapshots) {
                const item = document.createElement('div');
                item.className = 'chat_sentinel_item';

                const name = document.createElement('div');
                name.className = 'chat_sentinel_name';
                name.title = snapshot.name;
                name.textContent = displaySnapshotName(snapshot.name);

                const meta = document.createElement('div');
                meta.className = 'chat_sentinel_meta';
                const keepText = snapshot.kept ? 'KEEP · ' : '';
                const messageText = snapshot.messageCount === null ? '' : `${snapshot.messageCount} 条 · `;
                meta.textContent = `${keepText}${messageText}${formatBytes(snapshot.size)} · ${formatShortTime(snapshot.mtimeMs)}`;

                item.append(name, meta);
                list.append(item);
            }
        }

        if (showToast) {
            setStatus('已刷新快照列表。');
        }
    } catch (error) {
        console.error('[chat-sentinel-backup] list failed:', error);
        setStatus(`读取快照列表失败：${error.message}`, true);
    }
}

function bindSettingsUi() {
    const currentSettings = settings();
    $('#chat_sentinel_enabled').prop('checked', currentSettings.enabled);
    $('#chat_sentinel_interval').val(currentSettings.intervalSeconds);
    $('#chat_sentinel_keep').val(currentSettings.keepPerChat);
    setStatus(lastStatus);

    $(document).on('change', '#chat_sentinel_enabled', function () {
        currentSettings.enabled = Boolean($(this).prop('checked'));
        saveSettingsDebounced();
        setStatus(currentSettings.enabled ? '守护备份已启用。' : '守护备份已暂停。');
    });

    $(document).on('change', '#chat_sentinel_interval', function () {
        currentSettings.intervalSeconds = clampNumber($(this).val(), 5, 300, DEFAULT_SETTINGS.intervalSeconds);
        $(this).val(currentSettings.intervalSeconds);
        saveSettingsDebounced();
    });

    $(document).on('change', '#chat_sentinel_keep', function () {
        currentSettings.keepPerChat = clampNumber($(this).val(), 5, 500, DEFAULT_SETTINGS.keepPerChat);
        $(this).val(currentSettings.keepPerChat);
        saveSettingsDebounced();
    });

    $(document).on('click', '#chat_sentinel_backup_now', () => runSnapshot('manual'));
    $(document).on('click', '#chat_sentinel_backup_all', () => runEntitySnapshot());
    $(document).on('click', '#chat_sentinel_choose', () => loadPicker(true));
    $(document).on('click', '#chat_sentinel_versions_open', () => loadVersions(true));
    $(document).on('click', '#chat_sentinel_deleted_open', () => loadDeletedChats(true));
    $(document).on('click', '#chat_sentinel_versions_all', () => {
        $('.chat_sentinel_version_checkbox').prop('checked', true);
        clearVersionPreview('已全选。点“查看两轮”会显示第一个已选快照。');
    });
    $(document).on('click', '#chat_sentinel_versions_none', () => {
        $('.chat_sentinel_version_checkbox').prop('checked', false);
        clearVersionPreview();
    });
    $(document).on('change', '.chat_sentinel_version_checkbox', () => previewSelectedVersion(false));
    $(document).on('click', '#chat_sentinel_versions_preview', () => previewSelectedVersion(true));
    $(document).on('click', '#chat_sentinel_versions_keep', () => setSelectedVersionsKept(true));
    $(document).on('click', '#chat_sentinel_versions_unkeep', () => setSelectedVersionsKept(false));
    $(document).on('click', '#chat_sentinel_versions_delete', () => deleteSelectedVersions());
    $(document).on('click', '#chat_sentinel_versions_restore', () => restoreSelectedVersion());
    $(document).on('click', '#chat_sentinel_deleted_all', () => $('.chat_sentinel_deleted_checkbox').prop('checked', true));
    $(document).on('click', '#chat_sentinel_deleted_none', () => $('.chat_sentinel_deleted_checkbox').prop('checked', false));
    $(document).on('click', '#chat_sentinel_deleted_restore', () => restoreSelectedDeletedChat());
    $(document).on('click', '#chat_sentinel_deleted_purge', () => purgeSelectedDeletedChats());
    $(document).on('click', '#chat_sentinel_select_all', () => $('.chat_sentinel_pick_checkbox').prop('checked', true));
    $(document).on('click', '#chat_sentinel_select_none', () => $('.chat_sentinel_pick_checkbox').prop('checked', false));
    $(document).on('click', '#chat_sentinel_backup_selected', () => runSelectedSnapshot());
    $(document).on('click', '#chat_sentinel_refresh', () => refreshList(true));
    $(document).on('click', '#chat_sentinel_backup_settings .inline-drawer-toggle', () => refreshList(false));
}

function bindEvents() {
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
        eventSource.on(eventName, () => scheduleSnapshot(eventName));
    }

    if (event_types.CHAT_DELETED) {
        eventSource.on(event_types.CHAT_DELETED, (chatId) => markDeletedChat(chatId, false));
    }

    if (event_types.GROUP_CHAT_DELETED) {
        eventSource.on(event_types.GROUP_CHAT_DELETED, (chatId) => markDeletedChat(chatId, true));
    }

}

async function initialize() {
    if (initialized) {
        return;
    }

    initialized = true;
    settings();

    const html = await renderExtensionTemplateAsync(`third-party/${MODULE_NAME}`, 'settings');
    $('#extensions_settings').append(html);
    bindSettingsUi();
    bindEvents();
    refreshList(false);
}

eventSource.on(event_types.APP_READY, initialize);

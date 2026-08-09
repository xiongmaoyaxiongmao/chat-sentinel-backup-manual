import { createDialogs } from './dialogs.js';
import { renderOverview, setOverviewNotice } from './views/overview.js';
import {
    renderDetailLoading,
    renderHistoryList,
    renderQuarantine,
    renderVersionDetail,
} from './views/history.js';
import { renderRecycleBin } from './views/recycle-bin.js';
import { renderSettings } from './views/settings-view.js';

const MANAGER_SCROLL_LOCK_CLASS = 'chat_sentinel_manager_open';
const MANAGER_SCROLL_OFFSET = '--chat-sentinel-page-scroll-offset';

export function createPageScrollOwner({
    windowRef = window,
    documentRef = document,
} = {}) {
    let state = null;

    function keepHorizontalOrigin() {
        if (state && windowRef.scrollX !== 0) windowRef.scrollTo(0, windowRef.scrollY);
    }

    function lock() {
        if (state) return;
        const documentRoot = documentRef.documentElement;
        const body = documentRef.body;
        state = {
            scrollY: windowRef.scrollY,
            rootHadClass: documentRoot.classList.contains(MANAGER_SCROLL_LOCK_CLASS),
            bodyHadClass: body.classList.contains(MANAGER_SCROLL_LOCK_CLASS),
            offsetValue: body.style.getPropertyValue(MANAGER_SCROLL_OFFSET),
            offsetPriority: body.style.getPropertyPriority(MANAGER_SCROLL_OFFSET),
        };

        documentRoot.classList.add(MANAGER_SCROLL_LOCK_CLASS);
        windowRef.scrollTo(0, state.scrollY);
        body.style.setProperty(MANAGER_SCROLL_OFFSET, `${-state.scrollY}px`);
        body.classList.add(MANAGER_SCROLL_LOCK_CLASS);
        windowRef.addEventListener('scroll', keepHorizontalOrigin, { passive: true });
    }

    function unlock() {
        if (!state) return;
        const snapshot = state;
        const documentRoot = documentRef.documentElement;
        const body = documentRef.body;

        windowRef.removeEventListener('scroll', keepHorizontalOrigin);
        if (!snapshot.bodyHadClass) body.classList.remove(MANAGER_SCROLL_LOCK_CLASS);
        if (snapshot.offsetValue) {
            body.style.setProperty(MANAGER_SCROLL_OFFSET, snapshot.offsetValue, snapshot.offsetPriority);
        } else {
            body.style.removeProperty(MANAGER_SCROLL_OFFSET);
        }
        windowRef.scrollTo(0, snapshot.scrollY);
        if (!snapshot.rootHadClass) documentRoot.classList.remove(MANAGER_SCROLL_LOCK_CLASS);
        state = null;
    }

    return { lock, unlock };
}

function chatPayload(chat) {
    return { opaqueKey: chat.opaqueKey };
}

export function createManager({
    root,
    api,
    getCurrentIdentity,
    getSettings,
    updateSettings,
    version,
}) {
    const dialogs = createDialogs(root);
    const list = root.querySelector('[data-history-list]');
    const detail = root.querySelector('[data-version-detail]');
    const historySplit = root.querySelector('[data-history-split]');
    const historyBack = root.querySelector('[data-history-back]');
    const content = root.querySelector('.chat_sentinel_content');
    const search = root.querySelector('[data-history-search]');
    const pickerDialog = root.querySelector('#chat_sentinel_picker_dialog');
    let health = null;
    let currentIdentity = null;
    let currentTab = 'current';
    let allGroups = [];
    let returnFocus = null;
    let pickerReturnFocus = null;
    let pickerEntityKey = null;
    let historyReturnFocus = null;
    const pageScrollOwner = createPageScrollOwner();

    function visibleFocusables() {
        return [...root.querySelectorAll(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
        )].filter((element) => (
            !element.closest('[hidden]')
            && !element.closest('dialog:not([open])')
            && element.getClientRects().length > 0
            && getComputedStyle(element).visibility !== 'hidden'
        ));
    }

    function isVisibleFocusTarget(element) {
        return Boolean(
            element?.isConnected
            && !element.disabled
            && element.getClientRects().length > 0
            && getComputedStyle(element).visibility !== 'hidden',
        );
    }

    function restoreManagerFocus() {
        if (isVisibleFocusTarget(returnFocus)) {
            returnFocus.focus();
            return;
        }
        const extensionDrawerButton = document.querySelector('.drawer-icon.fa-cubes[role="button"]');
        if (isVisibleFocusTarget(extensionDrawerButton)) extensionDrawerButton.focus();
    }

    function closePicker() {
        if (pickerDialog.open) pickerDialog.close();
        pickerReturnFocus?.focus?.();
    }

    function notify(message, tone = 'normal') {
        setOverviewNotice(root, message, tone);
        const entry = document.getElementById('chat_sentinel_entry_status');
        if (entry) entry.textContent = message;
    }

    function showPage(name) {
        if (name !== 'history') resetHistoryDetail();
        root.querySelectorAll('[data-page]').forEach((page) => {
            page.hidden = page.dataset.page !== name;
        });
        root.querySelectorAll('[data-view]').forEach((button) => {
            const active = button.dataset.view === name;
            button.classList.toggle('is_active', active);
            if (active) button.setAttribute('aria-current', 'page');
            else button.removeAttribute('aria-current');
        });
        content.scrollTop = 0;
        if (name === 'history') loadHistory(currentTab);
        if (name === 'settings') renderSettings(root, getSettings(), health, version);
    }

    function focusHistoryListItem(name) {
        const buttons = [...list.querySelectorAll('[data-snapshot-name]')];
        const matchingButton = buttons.find((button) => button.dataset.snapshotName === name);
        const fallback = matchingButton || buttons[0] || root.querySelector(`[data-history-tab="${currentTab}"]`) || search;
        if (isVisibleFocusTarget(fallback)) fallback.focus();
    }

    function resetHistoryDetail({ restoreFocus = false, fallbackSnapshotName = null } = {}) {
        const previousFocus = historyReturnFocus;
        historySplit.dataset.historyMode = 'list';
        delete detail.dataset.name;
        detail.innerHTML = '<div class="chat_sentinel_empty">选择一个版本查看详情。</div>';
        if (restoreFocus && isVisibleFocusTarget(previousFocus)) previousFocus.focus();
        else if (restoreFocus) focusHistoryListItem(fallbackSnapshotName || previousFocus?.dataset?.snapshotName);
        historyReturnFocus = null;
    }

    async function refreshHealth() {
        let identity = null;
        try {
            identity = await getCurrentIdentity();
            currentIdentity = identity;
        } catch {}
        health = await api.post('/health', identity ? { opaqueKey: identity.opaqueKey } : {});
        renderOverview(root, { enabled: getSettings().enabled, payload: identity, health });
        renderSettings(root, getSettings(), health, version);
        return health;
    }

    async function protectCurrent(confirmRegression = false) {
        let identity;
        try {
            identity = await getCurrentIdentity();
        } catch (error) {
            notify(error.message, 'danger');
            return;
        }
        notify('正在从本地已落盘聊天创建快照…');
        try {
            const result = await api.post('/snapshot', {
                opaqueKey: identity.opaqueKey,
                reason: 'manual',
                keepPerChat: getSettings().keepPerChat,
                confirmRegression,
            });
            notify(result.skipped ? '内容没有变化，现有快照仍然有效。' : `已保护当前聊天：${result.messageCount} 条消息。`, 'success');
            await refreshHealth();
        } catch (error) {
            if (error.code === 'message_count_regression' && !confirmRegression) {
                const ok = await dialogs.ask({
                    heading: '确认这次大幅删改',
                    message: `历史完整版本有 ${error.details.baselineMessageCount} 条，当前只有 ${error.details.currentMessageCount} 条。继续前会把旧完整版本设为长期保留，并把当前状态标记为人工确认。`,
                    confirmText: '保护旧版并继续',
                    danger: true,
                });
                if (ok) await protectCurrent(true);
                return;
            }
            notify(`保护失败：${error.message}`, 'danger');
        }
    }

    async function protectEntity() {
        let identity;
        try {
            identity = await getCurrentIdentity();
        } catch (error) {
            notify(error.message, 'danger');
            return;
        }
        notify('正在保护这个角色的全部聊天…');
        try {
            const result = await api.post('/snapshot-all', {
                opaqueKey: identity.opaqueKey,
                reason: 'manual-all',
                keepPerChat: getSettings().keepPerChat,
            });
            notify(`完成：保护 ${result.written}/${result.total} 个聊天，跳过 ${result.skipped} 个。`, 'success');
            await refreshHealth();
        } catch (error) {
            notify(`批量保护失败：${error.message}`, 'danger');
        }
    }

    async function chooseChats() {
        let identity;
        try {
            identity = await getCurrentIdentity();
        } catch (error) {
            notify(error.message, 'danger');
            return;
        }
        const dialog = pickerDialog;
        const pickerList = dialog.querySelector('[data-chat-picker-list]');
        pickerList.textContent = '正在读取聊天列表…';
        try {
            const result = await api.post('/entity-chats', { opaqueKey: identity.opaqueKey });
            pickerEntityKey = identity.opaqueKey;
            pickerList.innerHTML = '';
            for (const chat of result.chats) {
                const label = document.createElement('label');
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.value = chat.opaqueKey;
                const text = document.createElement('span');
                text.textContent = `${chat.name} · ${chat.messageCount} 条`;
                label.append(checkbox, text);
                pickerList.append(label);
            }
            pickerReturnFocus = document.activeElement;
            dialog.showModal();
            dialog.querySelector('[data-picker-cancel]').focus();
        } catch (error) {
            notify(`读取聊天列表失败：${error.message}`, 'danger');
        }
    }

    async function confirmPicker() {
        const dialog = pickerDialog;
        const selected = [...dialog.querySelectorAll('input:checked')].map((item) => item.value);
        if (!selected.length) return;
        closePicker();
        const result = await api.post('/snapshot-selected', {
            opaqueKey: pickerEntityKey,
            selectedOpaqueKeys: selected,
            keepPerChat: getSettings().keepPerChat,
        });
        notify(`已保护 ${result.written} 个已选聊天。`, 'success');
        await refreshHealth();
    }

    async function selectSnapshot(snapshot, chat, trigger) {
        const selectedName = snapshot.name;
        historyReturnFocus = trigger || document.activeElement;
        historySplit.dataset.historyMode = 'detail';
        detail.dataset.name = selectedName;
        renderDetailLoading(detail);
        if (isVisibleFocusTarget(historyBack)) historyBack.focus();
        try {
            const preview = await api.post('/history/preview', {
                ...chatPayload(chat),
                name: snapshot.name,
                rounds: 3,
            });
            if (detail.dataset.name !== selectedName) return;
            renderVersionDetail(detail, { snapshot, chat, preview }, handleVersionAction);
        } catch (error) {
            if (detail.dataset.name === selectedName) detail.textContent = `无法读取这个版本：${error.message}`;
        }
    }

    async function handleVersionAction(action, snapshot, chat) {
        const payload = { ...chatPayload(chat), selected: [snapshot.name], name: snapshot.name };
        if (action === 'restore') {
            const ok = await dialogs.ask({
                heading: '恢复到这个版本',
                message: '恢复前会先把当前聊天保存为不可自动清理的保险快照。完成后请重新打开聊天查看。',
                confirmText: '先保存当前版本并恢复',
                danger: true,
            });
            if (!ok) return;
            try {
                const result = await api.post('/history/restore', payload);
                notify(`恢复完成。保险快照：${result.preRestoreSnapshot || '目标原本不存在'}。`, 'success');
            } catch (error) {
                const rollback = error.details?.rollback;
                const rollbackText = rollback === 'completed'
                    ? '；原聊天已回滚。'
                    : rollback === 'failed'
                        ? '；回滚未完整完成。请停止恢复、清理或删除操作，保留当前文件现场并检查存储健康。'
                        : '';
                notify(`恢复失败：${error.message}${rollbackText}`, 'danger');
            }
        } else if (action === 'trash') {
            const ok = await dialogs.ask({
                heading: '移到回收站',
                message: '这个版本会从普通历史隐藏，仍可在回收站放回。',
                confirmText: '移到回收站',
            });
            if (ok) await api.post('/history/trash', payload);
        } else {
            await api.post('/history/keep', { ...payload, keep: action === 'keep' });
        }
        await loadHistory(currentTab, { focusSnapshotName: snapshot.name });
        await refreshHealth();
    }

    async function handleTrashAction(action, snapshot) {
        if (action === 'restore-chat') {
            const ok = await dialogs.ask({
                heading: '恢复这个聊天',
                message: '如果原位置已有聊天，会先创建恢复前保险快照，再安全恢复。',
                confirmText: '恢复聊天',
                danger: true,
            });
            if (!ok) return;
            const result = await api.post('/trash/restore-chat', { name: snapshot.name });
            notify(`聊天已恢复。保险快照：${result.preRestoreSnapshot || '目标原本不存在'}。`, 'success');
        } else if (action === 'restore-version') {
            await api.post('/trash/restore', { selected: [snapshot.name] });
        } else {
            const ok = await dialogs.ask({
                heading: '永久删除快照',
                message: '永久删除后无法从聊天守护恢复。',
                confirmText: '永久删除',
                danger: true,
            });
            if (!ok) return;
            await api.post('/trash/purge', { selected: [snapshot.name] });
        }
        await loadHistory('trash');
    }

    async function loadHistory(tab = currentTab, { focusSnapshotName = null } = {}) {
        currentTab = tab;
        root.querySelectorAll('[data-history-tab]').forEach((button) => {
            button.setAttribute('aria-selected', String(button.dataset.historyTab === tab));
        });
        resetHistoryDetail();
        list.textContent = '正在读取本地备份索引…';
        try {
            if (tab === 'trash') {
                const result = await api.post('/trash/list');
                renderRecycleBin(list, result.snapshots, handleTrashAction);
                renderQuarantine(list, result.quarantine);
                if (focusSnapshotName) focusHistoryListItem(focusSnapshotName);
                return;
            }
            if (tab === 'current') {
                const identity = await getCurrentIdentity();
                const result = await api.post('/history/current', { opaqueKey: identity.opaqueKey });
                allGroups = [{ ...result.identity, snapshots: result.snapshots }];
            } else {
                const result = await api.post('/history/all');
                allGroups = result.groups;
                renderHistoryList(list, allGroups, selectSnapshot, search.value);
                renderQuarantine(list, result.quarantine);
                if (focusSnapshotName) focusHistoryListItem(focusSnapshotName);
                return;
            }
            renderHistoryList(list, allGroups, selectSnapshot, search.value);
            if (focusSnapshotName) focusHistoryListItem(focusSnapshotName);
        } catch (error) {
            list.textContent = `读取失败：${error.message}`;
        }
    }

    async function open(opener) {
        returnFocus = opener || document.activeElement;
        pageScrollOwner.lock();
        root.hidden = false;
        showPage('overview');
        root.querySelector('[data-manager-close]').focus();
        try {
            await refreshHealth();
        } catch (error) {
            health = null;
            renderOverview(root, { enabled: getSettings().enabled, payload: currentIdentity, health });
            renderSettings(root, getSettings(), health, version);
            notify(`本地存储检查失败：${error.message}`, 'danger');
        }
    }

    function close() {
        root.hidden = true;
        pageScrollOwner.unlock();
        restoreManagerFocus();
    }

    root.addEventListener('click', (event) => {
        const button = event.target.closest('[data-view]');
        if (button) showPage(button.dataset.view);
    });
    root.querySelector('[data-manager-close]').addEventListener('click', close);
    root.querySelector('[data-protect-current]').addEventListener('click', () => protectCurrent());
    root.querySelector('[data-open-history]').addEventListener('click', () => showPage('history'));
    historyBack.addEventListener('click', () => resetHistoryDetail({ restoreFocus: true }));
    root.querySelector('[data-protect-entity]').addEventListener('click', protectEntity);
    root.querySelector('[data-select-chats]').addEventListener('click', chooseChats);
    root.querySelectorAll('[data-history-tab]').forEach((button) => {
        button.addEventListener('click', () => loadHistory(button.dataset.historyTab));
    });
    search.addEventListener('input', () => {
        if (currentTab !== 'trash') renderHistoryList(list, allGroups, selectSnapshot, search.value);
    });
    root.querySelector('[data-setting-enabled]').addEventListener('change', (event) => {
        updateSettings({ enabled: event.target.checked });
        renderOverview(root, {
            enabled: getSettings().enabled,
            payload: currentIdentity || health?.current?.identity || null,
            health,
        });
    });
    root.querySelector('[data-setting-interval]').addEventListener('change', (event) => {
        updateSettings({ intervalSeconds: event.target.value });
        renderSettings(root, getSettings(), health, version);
    });
    root.querySelector('[data-setting-keep]').addEventListener('change', (event) => {
        updateSettings({ keepPerChat: event.target.value });
        renderSettings(root, getSettings(), health, version);
    });
    root.querySelector('[data-confirm-repair]').addEventListener('click', async () => {
        const ok = await dialogs.ask({
            heading: '确认已核对隔离项',
            message: '原文件会继续保留，无法推导的长期保留、回收站和去重状态不会被补造。确认后只解除保留清理与永久删除的安全锁。',
            confirmText: '我已核对，解除安全锁',
            danger: true,
        });
        if (!ok) return;
        try {
            await api.post('/maintenance/confirm-repair', { confirm: true });
            notify('已记录人工核对；隔离项仍会继续显示和保留。', 'success');
            await refreshHealth();
        } catch (error) {
            notify(`确认失败：${error.message}`, 'danger');
        }
    });
    root.querySelector('[data-picker-cancel]').addEventListener('click', closePicker);
    root.querySelector('[data-picker-confirm]').addEventListener('click', confirmPicker);
    pickerDialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        closePicker();
    });
    pickerDialog.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closePicker();
            return;
        }
        if (event.key !== 'Tab') return;
        const items = [...pickerDialog.querySelectorAll('button:not([disabled]), input:not([disabled])')];
        if (!items.length) return;
        const first = items[0];
        const last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    });
    root.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !root.querySelector('dialog[open]')) {
            event.preventDefault();
            event.stopPropagation();
            close();
            return;
        }
        if (event.key !== 'Tab' || root.querySelector('dialog[open]')) return;
        const focusables = visibleFocusables();
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables.at(-1);
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    });

    return { open, close, notify, refreshHealth, protectCurrent, loadHistory };
}

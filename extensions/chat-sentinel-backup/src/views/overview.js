function timeText(value) {
    if (!value) return '尚无';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '尚无';
    const today = new Date();
    const sameDay = date.getFullYear() === today.getFullYear()
        && date.getMonth() === today.getMonth()
        && date.getDate() === today.getDate();
    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return sameDay
        ? `今天 ${time}`
        : date.toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
}

function protectionStatus(enabled, payload, health) {
    if (health == null) return { text: '本地存储状态暂时不可用', tone: 'danger' };
    if (!health.healthy) return { text: '本地存储需要检查', tone: 'danger' };
    if (!enabled) return { text: '自动守护已暂停', tone: 'warning' };
    if (!payload?.opaqueKey) return { text: '打开聊天后即可查看保护状态', tone: 'normal' };
    const latest = health?.current?.latest;
    if (!latest) return { text: '自动守护已开启，尚无快照', tone: 'normal' };
    const count = Number.isInteger(latest.messageCount) ? ` ${latest.messageCount} 条消息` : '';
    return {
        text: latest.status === 'auto' ? `已自动保护${count}` : `最近已保护${count}`,
        tone: 'success',
    };
}

export function renderOverview(root, { enabled, payload, health }) {
    const status = protectionStatus(enabled, payload, health);
    root.querySelector('[data-summary-enabled]').textContent = enabled ? '已开启' : '已暂停';
    root.querySelector('[data-summary-chat]').textContent = payload?.entityName && payload?.chatId
        ? `${payload.entityName} / ${payload.chatId}`
        : '未打开聊天';
    root.querySelector('[data-summary-status]').textContent = status.text;
    root.querySelector('[data-summary-status-row]').dataset.tone = status.tone;
    root.querySelector('[data-summary-latest]').textContent = timeText(health?.current?.latest?.createdAt);
    root.querySelector('[data-summary-count]').textContent = health?.current
        ? `${health.current.versionCount} / 10`
        : '—';
    root.querySelector('[data-summary-health]').textContent = health?.healthy ? '正常' : '需要检查';
}

export function setOverviewNotice(root, message, tone = 'normal') {
    const notice = root.querySelector('[data-overview-notice]');
    notice.textContent = message || '';
    notice.dataset.tone = tone;
}

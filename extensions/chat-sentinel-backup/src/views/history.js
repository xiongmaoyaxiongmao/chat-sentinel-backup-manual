function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

function formatTime(value) {
    return value ? new Date(value).toLocaleString() : '未知时间';
}

function statusText(item) {
    if (item.rolling) return item.status === 'pre-restore' ? '恢复前保护' : '循环保护';
    if (item.status === 'pre-restore') return '恢复前保险';
    if (item.status === 'confirmed') return '人工确认删改';
    if (item.status === 'legacy') return '旧版快照';
    return item.status === 'manual' ? '手动保护' : '自动保护';
}

function snapshotButton(snapshot, previous, chat, onSelect) {
    const button = document.createElement('button');
    button.className = 'chat_sentinel_version_row';
    button.type = 'button';
    button.dataset.snapshotName = snapshot.name;

    const head = document.createElement('span');
    head.className = 'chat_sentinel_version_head';
    const time = document.createElement('strong');
    time.textContent = formatTime(snapshot.createdAt || snapshot.mtimeMs);
    const badges = document.createElement('span');
    badges.className = 'chat_sentinel_badges';
    if (snapshot.kept) {
        const kept = document.createElement('span');
        kept.className = 'chat_sentinel_badge';
        kept.textContent = '长期保留';
        badges.append(kept);
    }
    if (snapshot.status !== 'auto') {
        const status = document.createElement('span');
        status.className = 'chat_sentinel_badge is_neutral';
        status.textContent = statusText(snapshot);
        badges.append(status);
    }
    if (snapshot.rolling) {
        const rolling = document.createElement('span');
        rolling.className = 'chat_sentinel_badge is_neutral';
        rolling.textContent = `循环槽 ${snapshot.slot + 1}/10`;
        badges.append(rolling);
    }
    head.append(time, badges);

    const meta = document.createElement('span');
    meta.className = 'chat_sentinel_version_meta';
    const delta = previous && Number.isInteger(snapshot.messageCount) && Number.isInteger(previous.messageCount)
        ? snapshot.messageCount - previous.messageCount
        : null;
    const deltaText = delta === null ? '' : ` · 较上一版 ${delta >= 0 ? '+' : ''}${delta}`;
    meta.textContent = `${snapshot.messageCount ?? '—'} 条${deltaText} · ${formatBytes(snapshot.size)}`;
    button.append(head, meta);
    button.addEventListener('click', () => onSelect(snapshot, chat, button));
    return button;
}

export function renderHistoryList(container, groups, onSelect, query = '') {
    container.innerHTML = '';
    const normalized = query.trim().toLocaleLowerCase();
    let rendered = 0;
    for (const group of groups) {
        const searchable = `${group.entityName || ''} ${group.chatId || ''}`.toLocaleLowerCase();
        if (normalized && !searchable.includes(normalized)) continue;
        const section = document.createElement('section');
        section.className = 'chat_sentinel_history_group';
        const title = document.createElement('h4');
        title.textContent = `${group.entityName || (group.kind === 'group' ? '群聊' : '角色')} / ${group.chatId || '旧快照'}`;
        section.append(title);
        group.snapshots.forEach((item, index) => {
            section.append(snapshotButton(item, group.snapshots[index + 1], group, onSelect));
        });
        container.append(section);
        rendered += group.snapshots.length;
    }
    if (!rendered) {
        const empty = document.createElement('div');
        empty.className = 'chat_sentinel_empty';
        empty.textContent = normalized ? '没有匹配的备份。' : '这里还没有备份。';
        container.append(empty);
    }
}

export function renderQuarantine(container, items = []) {
    if (!items.length) return;
    const section = document.createElement('section');
    section.className = 'chat_sentinel_quarantine';
    const heading = document.createElement('h4');
    heading.textContent = '待归属旧备份 / 隔离项';
    const explanation = document.createElement('p');
    explanation.textContent = '这些原文件已完整保留，但现有证据不足以安全归入某个聊天，因此不会被自动移动或清理。';
    section.append(heading, explanation);
    for (const item of items) {
        const row = document.createElement('div');
        row.className = 'chat_sentinel_quarantine_row';
        const name = document.createElement('strong');
        name.textContent = item.name;
        const reason = document.createElement('span');
        reason.textContent = item.reason;
        row.append(name, reason);
        section.append(row);
    }
    container.append(section);
}

export function renderVersionDetail(container, { snapshot, chat, preview }, onAction) {
    container.innerHTML = '';
    const title = document.createElement('h4');
    title.textContent = snapshot.rolling ? '循环保护点详情' : '版本详情';
    const meta = document.createElement('dl');
    meta.className = 'chat_sentinel_detail_meta';
    const rows = [
        ['聊天', `${chat.entityName || '聊天'} / ${chat.chatId || '旧快照'}`],
        ['时间', formatTime(snapshot.createdAt || snapshot.mtimeMs)],
        ['消息数', `${snapshot.messageCount ?? '—'} 条`],
        ['状态', `${statusText(snapshot)}${snapshot.kept ? ' · 长期保留' : ''}`],
    ];
    for (const [label, value] of rows) {
        const wrapper = document.createElement('div');
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        dt.textContent = label;
        dd.textContent = value;
        wrapper.append(dt, dd);
        meta.append(wrapper);
    }
    const previewBox = document.createElement('div');
    previewBox.className = 'chat_sentinel_preview';
    const previewTitle = document.createElement('h5');
    previewTitle.textContent = '最近几轮';
    previewBox.append(previewTitle);
    if (!preview?.messages?.length) {
        const empty = document.createElement('p');
        empty.textContent = '没有可预览的消息。';
        previewBox.append(empty);
    } else {
        for (const message of preview.messages) {
            const item = document.createElement('div');
            item.className = `chat_sentinel_preview_message ${message.is_user ? 'is_user' : ''}`;
            const byline = document.createElement('strong');
            byline.textContent = message.name;
            const text = document.createElement('p');
            text.textContent = message.mes;
            item.append(byline, text);
            previewBox.append(item);
        }
    }

    const actions = document.createElement('div');
    actions.className = 'chat_sentinel_detail_actions';
    const restore = document.createElement('button');
    restore.className = 'menu_button chat_sentinel_primary';
    restore.textContent = '恢复到这个版本';
    restore.addEventListener('click', () => onAction('restore', snapshot, chat));
    if (snapshot.rolling) {
        actions.append(restore);
        container.append(title, meta, previewBox, actions);
        return;
    }
    const keep = document.createElement('button');
    keep.className = 'menu_button';
    keep.textContent = snapshot.kept ? '取消长期保留' : '长期保留';
    keep.addEventListener('click', () => onAction(snapshot.kept ? 'unkeep' : 'keep', snapshot, chat));
    const more = document.createElement('details');
    more.className = 'chat_sentinel_more';
    const summary = document.createElement('summary');
    summary.className = 'menu_button';
    summary.title = '更多操作';
    summary.setAttribute('aria-label', '更多版本操作');
    const icon = document.createElement('span');
    icon.className = 'fa-solid fa-ellipsis';
    icon.setAttribute('aria-hidden', 'true');
    summary.append(icon);
    const menu = document.createElement('div');
    menu.className = 'chat_sentinel_more_menu';
    const remove = document.createElement('button');
    remove.className = 'chat_sentinel_danger';
    remove.textContent = '移到回收站';
    remove.addEventListener('click', () => onAction('trash', snapshot, chat));
    menu.append(remove);
    more.append(summary, menu);
    actions.append(keep, restore, more);
    container.append(title, meta, previewBox, actions);
}

export function renderDetailLoading(container) {
    container.innerHTML = '<div class="chat_sentinel_empty">正在校验并读取版本预览…</div>';
}

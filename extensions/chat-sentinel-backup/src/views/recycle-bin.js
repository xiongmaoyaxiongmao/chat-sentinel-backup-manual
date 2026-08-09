export function renderRecycleBin(container, snapshots, onAction) {
    container.innerHTML = '';
    if (!snapshots.length) {
        const empty = document.createElement('div');
        empty.className = 'chat_sentinel_empty';
        empty.textContent = '回收站是空的。';
        container.append(empty);
        return;
    }
    for (const snapshot of snapshots) {
        const row = document.createElement('div');
        row.className = 'chat_sentinel_trash_row';
        const text = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = `${snapshot.chat?.entityName || '聊天'} / ${snapshot.chat?.chatId || '旧快照'}`;
        const meta = document.createElement('span');
        meta.textContent = `${snapshot.messageCount ?? '—'} 条 · ${new Date(snapshot.trashedAt).toLocaleString()}`;
        text.append(title, meta);
        const actions = document.createElement('div');
        const restore = document.createElement('button');
        restore.className = 'menu_button';
        restore.textContent = snapshot.trashReason === 'chat-deleted' ? '恢复聊天' : '放回历史';
        restore.addEventListener('click', () => onAction(
            snapshot.trashReason === 'chat-deleted' ? 'restore-chat' : 'restore-version',
            snapshot,
        ));
        const purge = document.createElement('button');
        purge.className = 'menu_button chat_sentinel_danger';
        purge.textContent = '永久删除';
        purge.addEventListener('click', () => onAction('purge', snapshot));
        actions.append(restore, purge);
        row.append(text, actions);
        container.append(row);
    }
}

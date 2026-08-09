export function renderSettings(root, settings, health, version) {
    const enabled = Boolean(settings.enabled);
    root.querySelector('[data-setting-enabled]').checked = enabled;
    root.querySelector('[data-setting-enabled-state]').textContent = enabled ? '已开启' : '已关闭';
    root.querySelector('[data-setting-interval]').value = settings.intervalSeconds;
    root.querySelector('[data-setting-keep]').value = settings.keepPerChat;

    const directory = health?.directory || '不可用';
    const directoryElement = root.querySelector('[data-setting-directory]');
    directoryElement.textContent = directory;
    directoryElement.title = directory;

    const storage = health?.storage;
    const destructiveBlocked = Boolean(storage?.destructiveBlocked);
    const healthy = Boolean(health?.healthy);
    const healthRow = root.querySelector('[data-storage-health-row]');
    const healthPanel = root.querySelector('[data-storage-health-panel]');
    const healthLabel = root.querySelector('[data-setting-health]');
    const healthDetail = root.querySelector('[data-setting-health-detail]');

    healthRow.classList.toggle('is_blocked', destructiveBlocked);
    healthPanel.classList.toggle('is_healthy', healthy);
    healthPanel.classList.toggle('is_blocked', destructiveBlocked);

    if (healthy) {
        healthLabel.textContent = '正常';
        healthDetail.textContent = '索引与本地存储状态正常，可以安全使用日常保护功能。';
    } else if (destructiveBlocked) {
        healthLabel.textContent = '需要核对';
        healthDetail.textContent = '为保护已有备份，清理与永久删除已暂停。请先核对隔离项，再决定是否解除安全锁。';
    } else if (health) {
        healthLabel.textContent = '需要检查';
        healthDetail.textContent = '检测到本地存储异常。请先保留现场并查看问题详情。';
    } else {
        healthLabel.textContent = '暂时不可用';
        healthDetail.textContent = '尚未取得本地存储状态，请稍后重新打开管理页。';
    }

    const confirmRepair = root.querySelector('[data-confirm-repair]');
    confirmRepair.hidden = !destructiveBlocked;
    root.querySelector('[data-setting-version]').textContent = version;
}

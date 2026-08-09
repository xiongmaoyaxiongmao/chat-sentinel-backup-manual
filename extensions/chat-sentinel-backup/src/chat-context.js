import {
    characters,
    getCurrentChatId,
    name2,
    this_chid,
} from '../../../../../script.js';
import { groups, selected_group } from '../../../../group-chats.js';

export function captureCurrentChat(reason = 'event', overrideChatId = '') {
    const activeChatId = String(overrideChatId || getCurrentChatId() || '').replace(/\.jsonl$/i, '');
    if (!activeChatId) throw new Error('当前没有可保护的聊天。');

    if (selected_group) {
        const group = groups.find((item) => String(item.id) === String(selected_group));
        const payload = {
            isGroup: true,
            entityId: String(selected_group),
            entityName: group?.name || '群聊',
            chatId: activeChatId,
            groupChatIds: Array.isArray(group?.chats) ? [...group.chats] : [],
            reason,
        };
        return Object.freeze(payload);
    }

    const character = this_chid !== undefined ? characters[this_chid] : null;
    const payload = {
        isGroup: false,
        entityId: character?.avatar || '',
        entityName: character?.name || name2 || '角色',
        chatId: activeChatId,
        reason,
    };
    if (!payload.entityId) throw new Error('请先打开一个角色聊天。');
    return Object.freeze(payload);
}

export function captureEntity() {
    return { ...captureCurrentChat('entity') };
}

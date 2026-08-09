function validateJsonlText(text, options = {}) {
    if (typeof text !== 'string' || text.length === 0) {
        throw new Error('JSONL 文件为空');
    }
    const lines = text.split(/\r?\n/);
    const objects = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.trim()) {
            continue;
        }
        try {
            const parsed = JSON.parse(line);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new Error('not an object');
            }
            objects.push(parsed);
        } catch (error) {
            throw new Error(`JSONL 第 ${index + 1} 行损坏：${error.message}`);
        }
    }
    const minimum = options.allowHeaderOnly ? 1 : 2;
    if (objects.length < minimum) {
        throw new Error('JSONL 没有可恢复的聊天消息');
    }
    return {
        objects,
        messageCount: Math.max(0, objects.length - 1),
        bytes: Buffer.byteLength(text, 'utf8'),
    };
}

function previewFromText(text, rounds = 3) {
    const validated = validateJsonlText(text);
    const messages = validated.objects.slice(1)
        .filter((item) => Object.hasOwn(item, 'mes') || Object.hasOwn(item, 'name'));
    const limit = Math.max(2, Math.min((Number(rounds) || 3) * 2, 16));
    return {
        messageCount: validated.messageCount,
        messages: messages.slice(-limit).map((message) => ({
            name: String(message.name || (message.is_user ? 'User' : 'Assistant')),
            is_user: Boolean(message.is_user),
            send_date: message.send_date || message.send_date_full || '',
            mes: String(message.mes || '').slice(0, 2400),
        })),
    };
}

module.exports = { previewFromText, validateJsonlText };

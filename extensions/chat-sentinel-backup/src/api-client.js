const API_BASE = '/api/plugins/chat_sentinel_backup';

export class SentinelApi {
    constructor({ getHeaders, compressRequest, fetchImpl = fetch } = {}) {
        this.getHeaders = getHeaders || (() => ({ 'Content-Type': 'application/json' }));
        this.compressRequest = compressRequest || (async (options) => options);
        this.fetchImpl = fetchImpl;
    }

    async post(route, body = {}) {
        const request = await this.compressRequest({
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify(body),
            cache: 'no-cache',
        });
        const response = await this.fetchImpl(`${API_BASE}${route}`, request);
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok === false) {
            const error = new Error(data.error || response.statusText || '本地请求失败');
            error.code = data.code || '';
            error.details = data;
            throw error;
        }
        return data;
    }
}

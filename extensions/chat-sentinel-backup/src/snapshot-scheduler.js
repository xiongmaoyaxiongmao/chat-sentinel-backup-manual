export class PerChatSnapshotScheduler {
    constructor({ intervalMs, run, onResult = () => {}, onError = () => {} }) {
        this.intervalMs = intervalMs;
        this.run = run;
        this.onResult = onResult;
        this.onError = onError;
        this.entries = new Map();
    }

    schedule(captured, reason) {
        let entry = this.entries.get(captured.key);
        if (!entry) {
            entry = { timer: null, running: false, dirty: false, latest: null, lastRunAt: 0 };
            this.entries.set(captured.key, entry);
        }
        entry.latest = {
            key: captured.key,
            payload: { ...captured.payload, reason },
            reason,
        };
        entry.dirty = true;
        if (entry.running || entry.timer) return;
        const delay = Math.max(1200, this.intervalMs() - (Date.now() - entry.lastRunAt));
        entry.timer = setTimeout(() => this.flush(captured.key), delay);
    }

    async flush(key) {
        const entry = this.entries.get(key);
        if (!entry || entry.running) return;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
        if (!entry.dirty || !entry.latest) return;
        const job = entry.latest;
        entry.dirty = false;
        entry.running = true;
        try {
            const result = await this.run(job);
            entry.lastRunAt = Date.now();
            this.onResult(job, result);
        } catch (error) {
            this.onError(job, error);
        } finally {
            entry.running = false;
            if (entry.dirty) {
                entry.timer = setTimeout(() => this.flush(key), 0);
            }
        }
    }

    async flushAll() {
        await Promise.all([...this.entries.keys()].map((key) => this.flush(key)));
    }
}

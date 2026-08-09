class KeyedTaskQueue {
    constructor() {
        this.tails = new Map();
    }

    run(key, task) {
        const previous = this.tails.get(key) || Promise.resolve();
        const next = previous.catch(() => {}).then(task);
        const settled = next.catch(() => {});
        const tracked = settled.finally(() => {
            if (this.tails.get(key) === tracked) {
                this.tails.delete(key);
            }
        });
        this.tails.set(key, tracked);
        return next;
    }
}

module.exports = { KeyedTaskQueue };

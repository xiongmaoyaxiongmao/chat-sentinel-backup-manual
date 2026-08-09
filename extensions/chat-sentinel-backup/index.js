import { eventSource, event_types } from '../../../../script.js';
import { initializeSentinel } from './src/controller.js';

let initialized = false;

async function initialize() {
    if (initialized) return;
    initialized = true;
    await initializeSentinel();
}

eventSource.on(event_types.APP_READY, initialize);

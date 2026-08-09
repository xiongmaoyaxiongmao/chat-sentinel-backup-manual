import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

function filesUnder(root, extensions) {
    const output = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) output.push(...filesUnder(full, extensions));
        else if (extensions.includes(path.extname(entry.name))) output.push(full);
    }
    return output;
}

const files = [
    ...filesUnder('plugins/chat-sentinel-backup', ['.cjs']),
    ...filesUnder('extensions/chat-sentinel-backup', ['.js']),
    ...filesUnder('tests', ['.mjs', '.cjs', '.js']),
];

for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax OK: ${files.length} files`);

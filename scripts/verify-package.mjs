import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

for (const path of [pkg.main, pkg.types, pkg.dsh?.bundle?.patch]) {
    if (typeof path !== 'string' || !existsSync(join(root, path))) {
        throw new Error(`declared package entry is missing: ${String(path)}`);
    }
}

function javascriptFiles(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? javascriptFiles(path) : entry.isFile() && path.endsWith('.js') ? [path] : [];
    });
}

for (const path of javascriptFiles(join(root, 'lib'))) {
    const checked = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    if (checked.status !== 0) {
        throw new Error(`syntax check failed for ${path}:\n${checked.stderr || checked.stdout}`);
    }
}

console.log(`verified ${pkg.name}@${pkg.version} (${javascriptFiles(join(root, 'lib')).length} JavaScript files)`);

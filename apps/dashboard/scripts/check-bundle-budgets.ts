import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { budgetsSchema, measureBundles } from './bundle-budgets.ts';

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const budgets = budgetsSchema.parse(JSON.parse(await readFile(join(appDir, 'bundle-budgets.json'), 'utf8')));
const measurements = await measureBundles(join(appDir, 'dist', 'client'), budgets);

let over = false;
for (const { key, kind, gzipBytes, budget } of measurements) {
    const ok = gzipBytes <= budget;
    over ||= !ok;
    console[ok ? 'log' : 'error'](
        `${ok ? '✓' : '✗'} ${kind} ${key}: ${String(gzipBytes)} / ${String(budget)} gzip bytes`,
    );
}
if (over) {
    process.exitCode = 1;
}

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkDestructive, checkDrift, checkLayout } from './migration-guards.ts';

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationsDir = join(appDir, 'migrations');

const failures: string[] = [...(await checkLayout(migrationsDir))];

for (const name of (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort()) {
    const result = checkDestructive(await readFile(join(migrationsDir, name), 'utf8'));
    switch (result.kind) {
        case 'ok':
            break;
        case 'contract':
            console.log(`${name}: contract step (${result.findings.join(', ')}), marker present`);
            break;
        case 'destructive':
            failures.push(
                `${name}: ${result.findings.join(', ')} without a first-line "-- contract: <what>; unused since <when>" marker`,
            );
            break;
    }
}

const drift = await checkDrift({ appDir, schemaPath: join(appDir, 'src/adapters/db/schema.ts'), migrationsDir });
if (drift.kind === 'drift') {
    failures.push(`schema drift: drizzle-kit would generate ${drift.newFiles.join(', ')}; run bun run db:generate`);
}

if (failures.length > 0) {
    console.error(failures.map((failure) => `✗ ${failure}`).join('\n'));
    process.exitCode = 1;
} else {
    console.log('✓ migrations: drizzle-kit output only, no drift, no unmarked destructive change');
}

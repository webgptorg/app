// Fills staging's placeholders from the local, git-ignored staging.env (docs/staging-runbook.md, Placeholders). Run it
// again whenever staging.env gains a value; it only replaces what is still a placeholder. --check changes nothing and
// exits 1 while a placeholder that staging.env could fill is left. staging.env holds no secret: IDs, domains,
// addresses and an SSH public key, all of which end up committed.
//
//   node scripts/staging/fill-placeholders.ts [--env-file staging.env] [--check]
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
    fillPlaceholders,
    LEFT_ON_PURPOSE,
    parseStagingEnv,
    STAGING_FILES,
    StagingValuesError,
} from './placeholders.ts';

const root = resolve(import.meta.dirname, '..', '..');
const { values: args } = parseArgs({
    options: { 'env-file': { type: 'string', default: join(root, 'staging.env') }, check: { type: 'boolean' } },
});

try {
    const values = parseStagingEnv(readFileSync(args['env-file'], 'utf8'));
    const keys = Object.keys(STAGING_FILES) as (keyof typeof STAGING_FILES)[];
    const input = Object.fromEntries(keys.map((key) => [key, readFileSync(join(root, STAGING_FILES[key]), 'utf8')]));
    const result = fillPlaceholders(input as Record<keyof typeof STAGING_FILES, string>, values);

    const check = args.check === true;
    if (!check) {
        for (const key of keys) {
            if (result.files[key] !== input[key]) writeFileSync(join(root, STAGING_FILES[key]), result.files[key]);
        }
    }
    for (const line of result.filled) console.log(`${check ? 'would fill' : 'filled'}  ${line}`);
    for (const { file, placeholder, reason } of result.left) console.log(`left    ${file}: ${placeholder} (${reason})`);
    const open = result.left.filter(({ placeholder }) => !Object.hasOwn(LEFT_ON_PURPOSE, placeholder));
    if (check && (result.filled.length > 0 || open.length > 0)) process.exitCode = 1;
} catch (error) {
    if (!(error instanceof StagingValuesError) && !(error instanceof Error && 'code' in error)) throw error;
    console.error(error.message);
    process.exitCode = 2;
}

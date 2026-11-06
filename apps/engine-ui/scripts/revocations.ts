// Issues the signed UI revocation list (C-06) for the release mirror's `release-log/revocations.json`: signed with the
// key from UI_RELEASE_KEY (base64url of the 32-byte seed; never a file in the repo, never printed), valid for 30 days
// unless --valid-days says less. --previous is the list published now, whose revoked versions are carried forward and
// whose issuedAt the new list must not predate; --first only when nothing is published yet.
//
//   UI_RELEASE_KEY=… bun run --filter @ptbk/engine-ui release:revocations (--first | --previous <file>)
//     [--revoke <version>=<reason>]… [--valid-days <n>] [--policy <file>]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { RELEASE_DIR, RELEASE_FILES, STAGING_POLICY_FILE } from './release/paths.ts';
import { issueRevocationList, parseRevokeArgument, parseValidDays } from './release/revocation-list.ts';
import { readTrustPolicy } from './release/trust-policy.ts';

const { values } = parseArgs({
    options: {
        first: { type: 'boolean' },
        previous: { type: 'string' },
        revoke: { type: 'string', multiple: true },
        'valid-days': { type: 'string' },
        policy: { type: 'string' },
    },
});
if ((values.first === true) === (values.previous !== undefined)) {
    throw new Error('pass --previous <file> with the published list, or --first when none is published yet');
}
const seed = process.env['UI_RELEASE_KEY'];
if (seed === undefined || seed === '') throw new Error('UI_RELEASE_KEY is not set');

const issued = await issueRevocationList({
    seed,
    policy: await readTrustPolicy(values.policy === undefined ? STAGING_POLICY_FILE : resolve(values.policy)),
    now: new Date(),
    validDays: parseValidDays(values['valid-days']),
    previous:
        values.previous === undefined
            ? null
            : (JSON.parse(await readFile(resolve(values.previous), 'utf8')) as unknown),
    revoke: (values.revoke ?? []).map(parseRevokeArgument),
});
await mkdir(RELEASE_DIR, { recursive: true });
const out = join(RELEASE_DIR, RELEASE_FILES.revocations);
await writeFile(out, `${JSON.stringify(issued.envelope, null, 2)}\n`);
const revoked = issued.list.revoked.map(({ version }) => version).join(', ') || 'none';
console.log(`wrote ${out}: issued ${issued.list.issuedAt}, expires ${issued.list.expiresAt}, revoked ${revoked}`);
console.log(`signed by key ${issued.keyId}; upload it as release-log/revocations.json`);

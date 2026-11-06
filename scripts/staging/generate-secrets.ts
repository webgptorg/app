// Prints every secret staging generates itself, each with where it goes (docs/staging-runbook.md, Secrets). Writes
// nothing: copy each value into the password manager and its destination, then clear the terminal.
//
//   node scripts/staging/generate-secrets.ts --relay relay-fsn.<staging zone> [--relay <another relay>]
import { parseArgs } from 'node:util';

import { generateStagingSecrets } from './secrets.ts';

const HOSTNAME = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/;

const { values } = parseArgs({ options: { relay: { type: 'string', multiple: true } } });
const relays = values.relay ?? [];
if (relays.length === 0 || relays.some((relay) => !HOSTNAME.test(relay))) {
    console.error('usage: node scripts/staging/generate-secrets.ts --relay relay-fsn.<staging zone> [--relay ...]');
    process.exit(2);
}

const { secrets, releaseKeyPublic } = generateStagingSecrets(relays);
const lines = [
    'Staging secrets. Shown once and stored nowhere: copy each into the password manager now, then clear this terminal.',
    '',
];
for (const secret of secrets) {
    lines.push(secret.name, `  ${secret.value}`, ...secret.goesTo.map((target) => `  -> ${target}`), '');
}
lines.push(
    'UI staging release key, public half (not secret; commit it):',
    `  publicKey ${releaseKeyPublic.publicKey}`,
    `  keyid     ${releaseKeyPublic.keyid}`,
    '',
    'Not generated here:',
    '  - SSH: use your own admin key, ideally on a hardware key (ssh-keygen -t ed25519-sk); its public half goes into',
    '    admins in infra/relay/environments/staging/terraform.tfvars. Without a hardware token: ssh-keygen -t ed25519,',
    '    with a passphrase.',
    '  - The relay registry token: minted against D1 by apps/dashboard/scripts/mint-relay-key.ts (runbook, Relay).',
    '  - Cloudflare and Hetzner API tokens: created in their dashboards (runbook, API tokens).',
);
console.log(lines.join('\n'));

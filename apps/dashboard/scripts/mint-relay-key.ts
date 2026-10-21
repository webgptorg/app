// Mints or revokes a relay key (D-04) against one environment's D1 through wrangler. Rotation: mint, deploy the new
// token to the relay (I-01), then revoke the old row. Only the token's hash reaches wrangler, D1 and the shell.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cryptoRandom } from '../src/adapters/crypto-random.ts';
import { mintRelayKey, parseArgs, revokeRelayKeySql, USAGE, wranglerArgs } from './relay-keys.ts';

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const wrangler = join(appDir, 'node_modules', '.bin', 'wrangler');

function run(args: readonly string[]): void {
    execFileSync(wrangler, args, { cwd: appDir, stdio: ['ignore', 'inherit', 'inherit'] });
}

const command = parseArgs(process.argv.slice(2));
switch (command.kind) {
    case 'usage':
        console.error(`${command.problem}\n${USAGE}`);
        process.exitCode = 2;
        break;
    case 'revoke':
        run(wranglerArgs(command.target, revokeRelayKeySql(command.id, Date.now())));
        console.log(`Revoked relay key row ${command.id} if it was live (check "changes": 1 above).`);
        break;
    case 'mint': {
        const key = await mintRelayKey({ ...command, random: cryptoRandom, nowMs: Date.now() });
        run(wranglerArgs(command.target, key.sql));
        console.log(
            [
                `Relay key for ${command.relayId}: row ${key.id}, expires ${new Date(key.expiresAt).toISOString()}.`,
                'Set it as RELAY_REGISTRY_TOKEN on that relay. It is shown only now:',
                '',
                key.token,
            ].join('\n'),
        );
        break;
    }
}

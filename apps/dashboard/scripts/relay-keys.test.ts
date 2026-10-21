import { readdir, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { cryptoRandom } from '../src/adapters/crypto-random.ts';
import { RELAY_TOKEN_PATTERN, sha256Hex } from '../src/domain/auth/secrets.ts';
import { DEFAULT_RELAY_KEY_DAYS, mintRelayKey, parseArgs, revokeRelayKeySql, wranglerArgs } from './relay-keys.ts';

const NOW = 1_800_000_000_000;
const MIGRATIONS = new URL('../migrations/', import.meta.url);

/** The dashboard's schema after every migration, in SQLite as D1 runs it. */
async function migratedDatabase(): Promise<DatabaseSync> {
    const db = new DatabaseSync(':memory:');
    for (const name of (await readdir(MIGRATIONS)).filter((file) => file.endsWith('.sql')).sort()) {
        db.exec((await readFile(new URL(name, MIGRATIONS), 'utf8')).replaceAll('--> statement-breakpoint', ''));
    }
    return db;
}

describe('mint-relay-key', () => {
    it('mints a token in the relay key format and writes a row that holds only its hash', async () => {
        const key = await mintRelayKey({ relayId: 'relay-1.ptbk.test', days: 365, random: cryptoRandom, nowMs: NOW });
        expect(key.token).toMatch(RELAY_TOKEN_PATTERN);
        expect(key.sql).not.toContain(key.token);
        expect(key.sql).not.toContain(key.token.slice('ptbk_rt_'.length));
        const db = await migratedDatabase();
        db.exec(key.sql);
        const rows = db.prepare('SELECT * FROM relay_tokens').all();
        expect(rows).toEqual([
            {
                id: key.id,
                relay_id: 'relay-1.ptbk.test',
                token_hash: await sha256Hex(key.token),
                created_at: NOW,
                expires_at: NOW + 365 * 24 * 60 * 60 * 1000,
                last_used_at: null,
                revoked_at: null,
            },
        ]);
        db.exec(revokeRelayKeySql(key.id, NOW + 5));
        db.exec(revokeRelayKeySql(key.id, NOW + 9));
        expect(db.prepare('SELECT revoked_at FROM relay_tokens').all()).toEqual([{ revoked_at: NOW + 5 }]);
    });

    it('parses mint and revoke commands for one target', () => {
        expect(parseArgs(['--relay', 'relay-1.ptbk.io', '--env', 'production'])).toEqual({
            kind: 'mint',
            relayId: 'relay-1.ptbk.io',
            days: DEFAULT_RELAY_KEY_DAYS,
            target: { kind: 'remote', env: 'production' },
        });
        expect(parseArgs(['--local', '--relay', 'relay.ptbk.test', '--days', '30'])).toMatchObject({ days: 30 });
        expect(parseArgs(['--revoke', 'a'.repeat(26), '--env', 'staging'])).toEqual({
            kind: 'revoke',
            id: 'a'.repeat(26),
            target: { kind: 'remote', env: 'staging' },
        });
    });

    it.each([
        [[]],
        [['--relay', 'relay.ptbk.test']],
        [['--relay', 'relay.ptbk.test', '--local', '--env', 'staging']],
        [['--relay', 'relay.ptbk.test', '--env', 'dev']],
        [['--relay', "relay'); DROP TABLE x; --", '--local']],
        [['--relay', 'Relay.ptbk.test', '--local']],
        [['--relay', 'relay.ptbk.test', '--revoke', 'a'.repeat(26), '--local']],
        [['--revoke', 'not-an-id', '--local']],
        [['--revoke', 'a'.repeat(26), '--days', '3', '--local']],
        [['--relay', 'relay.ptbk.test', '--days', '0', '--local']],
        [['--relay', 'relay.ptbk.test', '--days', '731', '--local']],
        [['--relay', 'relay.ptbk.test', '--local', '--local']],
        [['--relay']],
        [['--token', 'x', '--local']],
    ])('refuses %j', (argv) => {
        expect(parseArgs(argv).kind).toBe('usage');
    });

    it('runs wrangler against the local or a remote environment', () => {
        expect(wranglerArgs({ kind: 'local' }, 'SELECT 1')).toEqual([
            'd1',
            'execute',
            'DB',
            '--local',
            '--command',
            'SELECT 1',
        ]);
        expect(wranglerArgs({ kind: 'remote', env: 'staging' }, 'SELECT 1')).toEqual([
            'd1',
            'execute',
            'DB',
            '--remote',
            '--env',
            'staging',
            '--command',
            'SELECT 1',
        ]);
    });
});

import { newRelayToken, sha256Hex } from '../src/domain/auth/secrets.ts';
import { newRelayTokenId, relayTokenIdSchema } from '../src/domain/ids.ts';
import type { Random } from '../src/domain/ports/random.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_RELAY_KEY_DAYS = 365;
const MAX_RELAY_KEY_DAYS = 730;
// The relay's hostname (its `relayId`); checked here because it is written into SQL as a literal.
const RELAY_ID = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export type Target = { readonly kind: 'local' } | { readonly kind: 'remote'; readonly env: 'staging' | 'production' };

export type Command =
    | { readonly kind: 'mint'; readonly relayId: string; readonly days: number; readonly target: Target }
    | { readonly kind: 'revoke'; readonly id: string; readonly target: Target }
    | { readonly kind: 'usage'; readonly problem: string };

export const USAGE = `Usage: node scripts/mint-relay-key.ts (--relay <relayId> [--days <1-${String(MAX_RELAY_KEY_DAYS)}>] | --revoke <id>) (--local | --env staging | --env production)`;

export function parseArgs(argv: readonly string[]): Command {
    const options = new Map<string, string | true>();
    for (let i = 0; i < argv.length; i++) {
        const name = argv[i] ?? '';
        if (!['--relay', '--days', '--revoke', '--env', '--local'].includes(name) || options.has(name)) {
            return { kind: 'usage', problem: `unexpected argument ${name}` };
        }
        if (name === '--local') {
            options.set(name, true);
            continue;
        }
        const value = argv[++i];
        if (value === undefined) {
            return { kind: 'usage', problem: `${name} needs a value` };
        }
        options.set(name, value);
    }
    const env = options.get('--env');
    const local = options.has('--local');
    if (local === (env !== undefined) || (env !== undefined && env !== 'staging' && env !== 'production')) {
        return { kind: 'usage', problem: 'pass exactly one of --local, --env staging, --env production' };
    }
    const target: Target = env === 'staging' || env === 'production' ? { kind: 'remote', env } : { kind: 'local' };
    const relayId = options.get('--relay');
    const revoke = options.get('--revoke');
    if ((relayId === undefined) === (revoke === undefined)) {
        return { kind: 'usage', problem: 'pass exactly one of --relay and --revoke' };
    }
    if (typeof revoke === 'string') {
        if (options.has('--days')) {
            return { kind: 'usage', problem: '--days goes with --relay' };
        }
        return relayTokenIdSchema.safeParse(revoke).success
            ? { kind: 'revoke', id: revoke, target }
            : { kind: 'usage', problem: '--revoke takes a token row id (26 characters of a-z and 2-7)' };
    }
    if (typeof relayId !== 'string' || !RELAY_ID.test(relayId)) {
        return { kind: 'usage', problem: '--relay takes the relay hostname, lowercase' };
    }
    const days = options.get('--days') ?? String(DEFAULT_RELAY_KEY_DAYS);
    if (typeof days !== 'string' || !/^\d{1,3}$/.test(days) || Number(days) < 1 || Number(days) > MAX_RELAY_KEY_DAYS) {
        return { kind: 'usage', problem: `--days takes 1 to ${String(MAX_RELAY_KEY_DAYS)}` };
    }
    return { kind: 'mint', relayId, days: Number(days), target };
}

export interface MintedRelayKey {
    /** Shown once, never written anywhere by the script. */
    readonly token: string;
    readonly id: string;
    readonly expiresAt: number;
    /** Holds only the token's SHA-256. */
    readonly sql: string;
}

export async function mintRelayKey(options: {
    readonly relayId: string;
    readonly days: number;
    readonly random: Random;
    readonly nowMs: number;
}): Promise<MintedRelayKey> {
    const token = newRelayToken(options.random);
    const id = newRelayTokenId(options.random);
    const expiresAt = options.nowMs + options.days * DAY_MS;
    const sql =
        'INSERT INTO relay_tokens (id, relay_id, token_hash, created_at, expires_at) VALUES ' +
        `('${id}', '${options.relayId}', '${await sha256Hex(token)}', ${String(options.nowMs)}, ${String(expiresAt)})`;
    return { token, id, expiresAt, sql };
}

export function revokeRelayKeySql(id: string, nowMs: number): string {
    return `UPDATE relay_tokens SET revoked_at = ${String(nowMs)} WHERE id = '${relayTokenIdSchema.parse(id)}' AND revoked_at IS NULL`;
}

export function wranglerArgs(target: Target, sql: string): string[] {
    const where = target.kind === 'local' ? ['--local'] : ['--remote', '--env', target.env];
    return ['d1', 'execute', 'DB', ...where, '--command', sql];
}

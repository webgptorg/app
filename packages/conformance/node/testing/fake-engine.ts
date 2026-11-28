/*
 * A tiny engine for the harness's self-test, run as `node fake-engine.ts` (type stripping, node:* imports only). It
 * implements registration and heartbeat from the guide with Node's own crypto, independently of @ptbk/protocol, so
 * the suites are proven against a second implementation. `FAKE_ENGINE_DEFECTS` (comma-separated) breaks one rule at
 * a time, and each check must fail for its defect.
 */
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import {
    closeSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const env = process.env;
const defects = new Set((env['FAKE_ENGINE_DEFECTS'] ?? '').split(',').filter((name) => name !== ''));
const dataDir = required('PTBK_DATA_DIR');
const engineDomain = required('PTBK_ENGINE_DOMAIN');
const dashboardUrl = required('PTBK_DASHBOARD_URL');
const intervalMs = Number(env['FAKE_HEARTBEAT_INTERVAL_S'] ?? '60') * 1000 * (defects.has('slow-heartbeat') ? 2 : 1);
const version = '0.0.1';
const startedAt = Date.now();
const REGISTER_RESPONSE_MAX_BYTES = 8192;

function required(name: string): string {
    const value = env[name];
    if (value === undefined || value === '') fatal(`${name} is required`);
    return value;
}

function fatal(message: string): never {
    process.stderr.write(`fake-engine: ${message}\n`);
    process.exit(1);
}

function log(event: string, fields: Record<string, unknown> = {}): void {
    process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
}

function isCode(error: unknown, code: string): boolean {
    return error instanceof Error && 'code' in error && error.code === code;
}

function checkPrivate(path: string, kind: 'directory' | 'file'): void {
    if (defects.has('no-permission-check')) return;
    const stats = lstatSync(path);
    if (defects.has('refuse-with-status-0') && (stats.isSymbolicLink() || (stats.mode & 0o077) !== 0)) {
        process.stderr.write(`fake-engine: ${path} is not private\n`);
        process.exit(0);
    }
    if (stats.isSymbolicLink()) fatal(`${path} is a symbolic link`);
    if (kind === 'directory' ? !stats.isDirectory() : !stats.isFile()) fatal(`${path} is not a ${kind}`);
    if (stats.uid !== process.getuid?.()) fatal(`${path} is not owned by this user`);
    if ((stats.mode & 0o077) !== 0) fatal(`${path} has mode ${(stats.mode & 0o777).toString(8)}`);
}

function privateDirectory(path: string): void {
    if (defects.has('symlinked-data-dir')) {
        mkdirSync(`${path}-target`, { mode: 0o700, recursive: true });
        try {
            symlinkSync(`${path}-target`, path);
        } catch (error) {
            if (!isCode(error, 'EEXIST')) throw error;
        }
    }
    try {
        mkdirSync(path, { mode: defects.has('loose-data-dir') ? 0o755 : 0o700 });
    } catch (error) {
        if (!isCode(error, 'EEXIST')) throw error;
    }
    checkPrivate(path, 'directory');
}

function loadOrCreateKey(): KeyObject {
    const path = join(dataDir, 'engine-key.pem');
    if (!defects.has('ephemeral-key')) {
        try {
            lstatSync(path);
            checkPrivate(path, 'file');
            return createPrivateKey(readFileSync(path));
        } catch (error) {
            if (!isCode(error, 'ENOENT')) throw error;
        }
    }
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    if (defects.has('log-private-key')) log('engine.key', { pem });
    if (defects.has('ephemeral-key')) return privateKey;
    const fd = openSync(path, 'wx', defects.has('loose-key-file') ? 0o644 : 0o600);
    writeFileSync(fd, pem);
    fsyncSync(fd);
    closeSync(fd);
    return privateKey;
}

function base64url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64url');
}

function base32Lower(bytes: Uint8Array): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of bytes) {
        value = ((value << 8) | byte) & 0xffff;
        bits += 8;
        while (bits >= 5) {
            out += alphabet.charAt((value >>> (bits - 5)) & 31);
            bits -= 5;
        }
    }
    if (bits > 0) out += alphabet.charAt((value << (5 - bits)) & 31);
    return out;
}

function signingInput(context: string, ...parts: (string | Uint8Array)[]): Buffer {
    const chunks = [Buffer.from('ptbk-sig\0', 'latin1'), Buffer.of(context.length), Buffer.from(context, 'ascii')];
    for (const part of parts) {
        const bytes = typeof part === 'string' ? Buffer.from(part, 'utf8') : Buffer.from(part);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(bytes.length);
        chunks.push(length, bytes);
    }
    return Buffer.concat(chunks);
}

interface Registration {
    readonly engineId: string;
    readonly hostname: string;
    readonly linkCode?: string;
}

const KNOWN_RESPONSE_FIELDS = new Set(['engineId', 'hostname', 'relays']);

class Retry extends Error {}

/** One attempt; a problem answer ends the process, as the guide allows, unless a defect retries in a loop. */
async function attemptRegistration(key: KeyObject, publicKey: Uint8Array, engineId: string): Promise<Registration> {
    const linkCode = required('PTBK_LINK_CODE');
    const mode = defects.has('wrong-mode') ? 'direct' : 'tunnel';
    if (defects.has('log-link-code')) log('registration.start', { linkCode });
    const signedCode = defects.has('bad-registration-signature') ? `${linkCode.slice(0, -1)}a` : linkCode;
    const sig = sign(null, signingInput('ptbk-register-v1', '1', signedCode, publicKey, version, mode), key);
    const body = {
        v: 1,
        linkCode,
        enginePublicKey: base64url(publicKey),
        engineVersion: version,
        mode,
        sig: base64url(sig),
        ...(defects.has('oversized-registration') ? { padding: 'x'.repeat(5000) } : {}),
    };
    const response = await fetch(new URL('/v1/engines/register', dashboardUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    if (text.length > REGISTER_RESPONSE_MAX_BYTES && !defects.has('accept-any-response')) {
        fatal('registration refused: the answer is too large');
    }
    const answer = JSON.parse(text) as Record<string, unknown>;
    if (response.status !== 200) {
        if (defects.has('retry-loop')) throw new Retry();
        fatal(defects.has('silent-errors') ? 'registration failed' : `registration refused: ${String(answer['code'])}`);
    }
    if (defects.has('strict-response') && Object.keys(answer).some((field) => !KNOWN_RESPONSE_FIELDS.has(field))) {
        fatal('registration refused: unknown fields in the answer');
    }
    const registration = {
        engineId: String(answer['engineId']),
        hostname: String(answer['hostname']),
        ...(defects.has('store-link-code') ? { linkCode } : {}),
    };
    const expected = registration.engineId === engineId && registration.hostname === `${engineId}.${engineDomain}`;
    if (!expected && !defects.has('accept-any-response')) {
        fatal('registration refused: the dashboard sent another identity');
    }
    writeFileSync(join(dataDir, 'registration.json'), JSON.stringify(registration), { mode: 0o600 });
    log('registration.registered', { engineId });
    return registration;
}

async function register(key: KeyObject, publicKey: Uint8Array, engineId: string): Promise<Registration> {
    const ignoreStored = defects.has('register-every-start') || defects.has('ephemeral-key');
    if (!ignoreStored) {
        try {
            return JSON.parse(readFileSync(join(dataDir, 'registration.json'), 'utf8')) as Registration;
        } catch {
            // Not registered yet.
        }
    }
    for (;;) {
        try {
            return await attemptRegistration(key, publicKey, engineId);
        } catch (error) {
            if (!(error instanceof Retry)) throw error;
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
    }
}

let lastSeq = 0;

function nextSeq(): number {
    if (defects.has('seq-from-zero')) return ++lastSeq;
    const path = join(dataDir, 'heartbeat-seq');
    let last = -1;
    try {
        last = Number(readFileSync(path, 'utf8'));
    } catch {
        // First beat.
    }
    const seq = Math.max(last + 1, Date.now());
    writeFileSync(`${path}.tmp`, String(seq), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    return seq;
}

function otherEngineId(engineId: string): string {
    return `${engineId.slice(0, -1)}${engineId.endsWith('a') ? 'b' : 'a'}`;
}

async function beat(key: KeyObject, engineId: string): Promise<number> {
    const sentId = defects.has('heartbeat-wrong-engine-id') ? otherEngineId(engineId) : engineId;
    const json = JSON.stringify({
        v: 1,
        engineId: sentId,
        seq: nextSeq(),
        ts: new Date(Date.now() - (defects.has('skewed-clock') ? 600_000 : 0)).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        version: defects.has('wrong-heartbeat-version') ? '9.9.9' : version,
        uptimeS: Math.floor((Date.now() - startedAt) / 1000),
        diskPct: defects.has('unrounded-percent') ? 43 : 40,
        ramPct: 50,
        cpuLoad: 'low',
        update: 'none',
        agents: 0,
        members: 1,
        ...(defects.has('extra-heartbeat-field') ? { hostname: 'leaks.example' } : {}),
        ...(defects.has('oversized-heartbeat') ? { padding: 'x'.repeat(13_000) } : {}),
    });
    const body = Buffer.from(defects.has('garbage-heartbeat-body') ? `${json}}` : json);
    const digest = createHash('sha256').update(body).digest();
    const signed = defects.has('bad-heartbeat-signature') ? Buffer.from(digest.toString('hex')) : digest;
    const signature = sign(null, signingInput('ptbk-heartbeat-v1', signed), key);
    const response = await fetch(new URL(`/v1/engines/${sentId}/heartbeat`, dashboardUrl), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(defects.has('no-signature-header') ? {} : { 'Ptbk-Signature': `ed25519=${base64url(signature)}` }),
        },
        body,
    });
    await response.body?.cancel();
    log('heartbeat.sent', { status: response.status });
    return response.status;
}

privateDirectory(dataDir);
const key = loadOrCreateKey();
const publicKey = Buffer.from(String(key.export({ format: 'jwk' }).x), 'base64url');
const engineId = base32Lower(createHash('sha256').update(publicKey).digest()).slice(0, 26);
const registration = await register(key, publicKey, engineId);
process.on('SIGTERM', () => process.exit(0));
const tick = (): void => {
    beat(key, registration.engineId)
        .then((status) => {
            if (status < 300) return;
            if (defects.has('stop-on-error')) fatal(`heartbeat refused with ${String(status)}`);
            if (defects.has('retry-failed-beat')) setTimeout(tick, 100);
        })
        .catch((error: unknown) => {
            log('heartbeat.failed', { problem: error instanceof Error ? error.name : 'unknown' });
        });
};
if (!defects.has('no-heartbeat')) {
    tick();
    setInterval(tick, intervalMs);
} else {
    setInterval(() => undefined, intervalMs);
}

/*
 * A tiny engine for the harness's self-test, run as `node fake-engine.ts` (type stripping, node:* imports only). It
 * implements registration and heartbeat from the guide with Node's own crypto, independently of @ptbk/protocol, so
 * the suites are proven against a second implementation. `FAKE_ENGINE_DEFECTS` (comma-separated) breaks one rule at
 * a time, and each check must fail for its defect.
 */
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;
const defects = new Set((env['FAKE_ENGINE_DEFECTS'] ?? '').split(',').filter((name) => name !== ''));
const dataDir = required('PTBK_DATA_DIR');
const engineDomain = required('PTBK_ENGINE_DOMAIN');
const dashboardUrl = required('PTBK_DASHBOARD_URL');
const intervalMs = Number(env['FAKE_HEARTBEAT_INTERVAL_S'] ?? '60') * 1000;
const version = '0.0.1';
const startedAt = Date.now();

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

function privateDirectory(path: string): void {
    try {
        mkdirSync(path, { mode: defects.has('loose-data-dir') ? 0o755 : 0o700 });
    } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    if (defects.has('no-permission-check')) return;
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) fatal(`${path} is a symbolic link`);
    if (stats.uid !== process.getuid?.()) fatal(`${path} is not owned by this user`);
    if ((stats.mode & 0o077) !== 0) fatal(`${path} has mode ${(stats.mode & 0o777).toString(8)}`);
}

function loadOrCreateKey(): KeyObject {
    const path = join(dataDir, 'engine-key.pem');
    try {
        const stats = lstatSync(path);
        if (!defects.has('no-permission-check')) {
            if (stats.isSymbolicLink()) fatal(`${path} is a symbolic link`);
            if ((stats.mode & 0o077) !== 0) fatal(`${path} has mode ${(stats.mode & 0o777).toString(8)}`);
        }
        return createPrivateKey(readFileSync(path));
    } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const { privateKey } = generateKeyPairSync('ed25519');
    const fd = openSync(path, 'wx', defects.has('loose-key-file') ? 0o644 : 0o600);
    writeFileSync(fd, privateKey.export({ type: 'pkcs8', format: 'pem' }));
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
        value = (value << 8) | byte;
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
}

async function register(key: KeyObject, publicKey: Uint8Array, engineId: string): Promise<Registration> {
    const path = join(dataDir, 'registration.json');
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as Registration;
    } catch {
        // Not registered yet.
    }
    const linkCode = required('PTBK_LINK_CODE');
    const mode = defects.has('wrong-mode') ? 'direct' : 'tunnel';
    const signedCode = defects.has('bad-registration-signature') ? `${linkCode.slice(0, -1)}a` : linkCode;
    const sig = sign(null, signingInput('ptbk-register-v1', '1', signedCode, publicKey, version, mode), key);
    const body = {
        v: 1,
        linkCode,
        enginePublicKey: base64url(publicKey),
        engineVersion: version,
        mode,
        sig: base64url(sig),
    };
    const response = await fetch(new URL('/v1/engines/register', dashboardUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const answer = (await response.json()) as Record<string, unknown>;
    if (response.status !== 200) fatal(`registration refused: ${String(answer['code'])}`);
    const registration = { engineId: String(answer['engineId']), hostname: String(answer['hostname']) };
    if (registration.engineId !== engineId || registration.hostname !== `${engineId}.${engineDomain}`) {
        fatal('registration refused: the dashboard sent another identity');
    }
    writeFileSync(path, JSON.stringify(registration), { mode: 0o600 });
    log('registration.registered', { engineId });
    return registration;
}

function nextSeq(): number {
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

async function beat(key: KeyObject, engineId: string): Promise<void> {
    const body = Buffer.from(
        JSON.stringify({
            v: 1,
            engineId,
            seq: nextSeq(),
            ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
            version,
            uptimeS: Math.floor((Date.now() - startedAt) / 1000),
            diskPct: 40,
            ramPct: 50,
            cpuLoad: 'low',
            update: 'none',
            agents: 0,
            members: 1,
        }),
    );
    const digest = createHash('sha256').update(body).digest();
    const signature = sign(null, signingInput('ptbk-heartbeat-v1', digest), key);
    const response = await fetch(new URL(`/v1/engines/${engineId}/heartbeat`, dashboardUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Ptbk-Signature': `ed25519=${base64url(signature)}` },
        body,
    });
    await response.body?.cancel();
    log('heartbeat.sent', { status: response.status });
}

privateDirectory(dataDir);
const key = loadOrCreateKey();
const publicKey = Buffer.from(String(key.export({ format: 'jwk' }).x), 'base64url');
const engineId = base32Lower(createHash('sha256').update(publicKey).digest()).slice(0, 26);
const registration = await register(key, publicKey, engineId);
process.on('SIGTERM', () => process.exit(0));
const tick = (): void => {
    beat(key, registration.engineId).catch((error: unknown) => {
        log('heartbeat.failed', { problem: error instanceof Error ? error.name : 'unknown' });
    });
};
tick();
setInterval(tick, intervalMs);

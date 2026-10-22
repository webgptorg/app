// `bun run dev:trust` and `dev:untrust` (X-06): the dev CA in the user's trust store (macOS login keychain, NSS on
// Linux) and a resolver for ptbk.test and engine.test only, never all of .test. Every change is a command printed before
// it runs, and all root work is one `sudo sh -c` with a fixed script, so there is one sudo prompt. Only node: imports.
import { spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DEV_CA_DOMAINS, DEV_PORTS } from './dev-stack-config.ts';

export type TrustPlatform = 'darwin' | 'linux';

/** The mock engine's dev CA subject (apps/mock-engine, `DEV_CA_NAME`); a regenerated CA keeps it. */
export const DEV_CA_COMMON_NAME = 'Promptbook mock engine dev CA';
export const NSS_NICKNAME = 'ptbk-dev-ca';
export const MAC_RESOLVER_DIR = '/etc/resolver';
export const MAC_RESOLVER_CONTENT = `nameserver 127.0.0.1\nport ${String(DEV_PORTS.dns)}\n`;
export const LINUX_RESOLVED_FILE = '/etc/systemd/resolved.conf.d/ptbk-dev.conf';
export const LINUX_RESOLVED_CONTENT = `[Resolve]\nDNS=127.0.0.1:${String(DEV_PORTS.dns)}\nDomains=${DEV_CA_DOMAINS.map((domain) => `~${domain}`).join(' ')}\n`;

export interface TrustStep {
    readonly description: string;
    readonly argv: readonly string[];
}

export type ResolverFileState = 'ours' | 'absent' | 'foreign';

/** What the host holds now: the CA in the user's store, and each resolver file. */
export interface TrustState {
    /** Linux: whether the user's NSS database exists yet (Chrome creates it on first start); macOS: always. */
    readonly storeExists: boolean;
    /** SHA-1 fingerprints (macOS: every certificate with the dev CA's name) or the NSS nickname, once per entry. */
    readonly storedCas: readonly string[];
    readonly resolverFiles: readonly { readonly path: string; readonly state: ResolverFileState }[];
}

export interface DevCaFacts {
    readonly certFile: string;
    /** Colon-free upper-case hex, as `security` prints it. */
    readonly sha1: string;
    readonly sha256: string;
}

export function resolverFiles(platform: TrustPlatform): readonly string[] {
    return platform === 'darwin'
        ? DEV_CA_DOMAINS.map((domain) => `${MAC_RESOLVER_DIR}/${domain}`)
        : [LINUX_RESOLVED_FILE];
}

export function resolverContent(platform: TrustPlatform): string {
    return platform === 'darwin' ? MAC_RESOLVER_CONTENT : LINUX_RESOLVED_CONTENT;
}

export function loginKeychain(home: string): string {
    return join(home, 'Library', 'Keychains', 'login.keychain-db');
}

export function nssDatabase(home: string): string {
    return `sql:${join(home, '.pki', 'nssdb')}`;
}

/** printf's format for `content`: only the characters the fixed resolver files use, newlines as `\n`. */
function printfFormat(content: string): string {
    if (!/^[A-Za-z0-9 .:=~[\]\n]*$/.test(content)) throw new Error('resolver content outside the fixed alphabet');
    return content.replaceAll('\n', '\\n');
}

function writeResolverScript(platform: TrustPlatform): string {
    const format = printfFormat(resolverContent(platform));
    if (platform === 'darwin') {
        return [
            `mkdir -p ${MAC_RESOLVER_DIR}`,
            ...resolverFiles(platform).map((file) => `printf "${format}" > ${file}`),
        ].join(' && ');
    }
    return [
        'mkdir -p /etc/systemd/resolved.conf.d',
        `printf "${format}" > ${LINUX_RESOLVED_FILE}`,
        'systemctl restart systemd-resolved',
    ].join(' && ');
}

function removeResolverScript(platform: TrustPlatform, files: readonly string[]): string {
    const remove = `rm -f ${files.join(' ')}`;
    return platform === 'darwin' ? remove : `${remove} && systemctl restart systemd-resolved`;
}

function foreignFiles(state: TrustState): readonly string[] {
    return state.resolverFiles.filter((file) => file.state === 'foreign').map((file) => file.path);
}

export type Plan =
    | { readonly kind: 'steps'; readonly steps: readonly TrustStep[] }
    | { readonly kind: 'refused'; readonly reason: string };

/** Adds what is missing, replaces a CA that is no longer the current one, and leaves anything foreign alone. */
export function trustPlan(platform: TrustPlatform, state: TrustState, ca: DevCaFacts, home: string): Plan {
    const foreign = foreignFiles(state);
    if (foreign.length > 0) {
        return {
            kind: 'refused',
            reason: `${foreign.join(', ')} exists with other content; remove it yourself, then run dev:trust again`,
        };
    }
    const steps: TrustStep[] = [];
    if (platform === 'darwin') {
        const keychain = loginKeychain(home);
        for (const sha1 of state.storedCas.filter((stored) => stored !== ca.sha1)) {
            steps.push({
                description: `remove an earlier dev CA (SHA-1 ${sha1}) from the login keychain`,
                argv: ['security', 'delete-certificate', '-Z', sha1, '-t', keychain],
            });
        }
        if (!state.storedCas.includes(ca.sha1)) {
            steps.push({
                description: 'trust the dev CA in the login keychain (macOS asks for your password or Touch ID)',
                argv: ['security', 'add-trusted-cert', '-r', 'trustRoot', '-k', keychain, ca.certFile],
            });
        }
    } else {
        const database = nssDatabase(home);
        if (!state.storeExists) {
            steps.push(
                {
                    description: 'create your NSS database',
                    argv: ['mkdir', '-p', join(home, '.pki', 'nssdb')],
                },
                {
                    description: 'initialise it without a password, as Chrome does',
                    argv: ['certutil', '-N', '-d', database, '--empty-password'],
                },
            );
        }
        steps.push(
            ...state.storedCas.map(() => ({
                description: 'remove the earlier dev CA from your NSS database',
                argv: ['certutil', '-D', '-d', database, '-n', NSS_NICKNAME],
            })),
        );
        steps.push({
            description: 'trust the dev CA in your NSS database (Chrome and Chromium read it)',
            argv: ['certutil', '-A', '-d', database, '-n', NSS_NICKNAME, '-t', 'C,,', '-i', ca.certFile],
        });
    }
    if (state.resolverFiles.some((file) => file.state === 'absent')) {
        steps.push({
            description: `resolve ${DEV_CA_DOMAINS.join(' and ')} through the stack's resolver on 127.0.0.1:${String(DEV_PORTS.dns)} (sudo)`,
            argv: ['sudo', 'sh', '-c', writeResolverScript(platform)],
        });
    }
    return { kind: 'steps', steps };
}

/** Removes every dev CA entry and our resolver files; a foreign resolver file is reported, never removed. */
export function untrustPlan(platform: TrustPlatform, state: TrustState, home: string): readonly TrustStep[] {
    const steps: TrustStep[] =
        platform === 'darwin'
            ? state.storedCas.map((sha1) => ({
                  description: `remove the dev CA (SHA-1 ${sha1}) and its trust settings from the login keychain`,
                  argv: ['security', 'delete-certificate', '-Z', sha1, '-t', loginKeychain(home)],
              }))
            : state.storedCas.map(() => ({
                  description: 'remove the dev CA from your NSS database',
                  argv: ['certutil', '-D', '-d', nssDatabase(home), '-n', NSS_NICKNAME],
              }));
    const ours = state.resolverFiles.filter((file) => file.state === 'ours').map((file) => file.path);
    if (ours.length > 0) {
        steps.push({
            description: `remove the resolver entries for ${DEV_CA_DOMAINS.join(' and ')} (sudo)`,
            argv: ['sudo', 'sh', '-c', removeResolverScript(platform, ours)],
        });
    }
    return steps;
}

/** What still makes the host trust the dev CA or resolve the test domains; empty once `dev:untrust` is complete. */
export function leftovers(state: TrustState): readonly string[] {
    return [
        ...state.storedCas.map((entry) => `dev CA still in the trust store (${entry})`),
        ...state.resolverFiles
            .filter((file) => file.state !== 'absent')
            .map((file) => `resolver entry ${file.path} still exists`),
    ];
}

/** Whether `dev:stack up` can expect a browser on this host to trust and find the stack. */
export function isTrusted(state: TrustState, ca: DevCaFacts, platform: TrustPlatform): boolean {
    const caTrusted = platform === 'darwin' ? state.storedCas.includes(ca.sha1) : state.storedCas.length > 0;
    return caTrusted && state.resolverFiles.every((file) => file.state === 'ours');
}

/** Shell form of a step, for printing; arguments with anything but safe characters are single-quoted. */
export function shellLine(argv: readonly string[]): string {
    return argv.map((arg) => (/^[\w./:=,@~+-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`)).join(' ');
}

interface Tlv {
    readonly tag: number;
    readonly start: number;
    readonly end: number;
}

function readTlv(der: Uint8Array, offset: number, limit: number): Tlv {
    const tag = der[offset];
    const first = der[offset + 1];
    if (tag === undefined || first === undefined) throw new Error('truncated DER');
    let position = offset + 2;
    let length = first;
    if (first >= 0x80) {
        const bytes = first & 0x7f;
        if (bytes === 0 || bytes > 3) throw new Error('unsupported DER length');
        length = 0;
        for (let index = 0; index < bytes; index += 1) length = length * 256 + (der[position++] ?? 0);
    }
    if (position + length > limit) throw new Error('truncated DER');
    return { tag, start: position, end: position + length };
}

function childrenOf(der: Uint8Array, parent: Tlv): readonly Tlv[] {
    const children: Tlv[] = [];
    for (let offset = parent.start; offset < parent.end;) {
        const child = readTlv(der, offset, parent.end);
        children.push(child);
        offset = child.end;
    }
    return children;
}

const NAME_CONSTRAINTS_OID = Uint8Array.of(0x55, 0x1d, 0x1e);
const TAG = { boolean: 0x01, octetString: 0x04, oid: 0x06, sequence: 0x30, permitted: 0xa0, extensions: 0xa3 } as const;
const DNS_NAME_TAG = 0x82;

function isOid(der: Uint8Array, tlv: Tlv | undefined, oid: Uint8Array): boolean {
    return (
        tlv?.tag === TAG.oid &&
        tlv.end - tlv.start === oid.length &&
        oid.every((byte, index) => der[tlv.start + index] === byte)
    );
}

/** The critical name constraints' permitted DNS names, or null without a critical extension that permits only DNS names. */
export function permittedDnsNames(der: Uint8Array): readonly string[] | null {
    const certificate = readTlv(der, 0, der.length);
    const tbs = childrenOf(der, certificate)[0];
    if (tbs === undefined) return null;
    const extensionsWrapper = childrenOf(der, tbs).find((child) => child.tag === TAG.extensions);
    const extensionList = extensionsWrapper === undefined ? undefined : childrenOf(der, extensionsWrapper)[0];
    if (extensionList === undefined) return null;
    for (const extension of childrenOf(der, extensionList)) {
        const [oid, ...rest] = childrenOf(der, extension);
        if (!isOid(der, oid, NAME_CONSTRAINTS_OID)) continue;
        const critical = rest.find((part) => part.tag === TAG.boolean);
        const value = rest.find((part) => part.tag === TAG.octetString);
        if (critical === undefined || der[critical.start] !== 0xff || value === undefined) return null;
        const constraints = readTlv(der, value.start, value.end);
        const permitted = childrenOf(der, constraints).find((part) => part.tag === TAG.permitted);
        if (permitted === undefined) return null;
        const names: string[] = [];
        for (const subtree of childrenOf(der, permitted)) {
            const base = childrenOf(der, subtree)[0];
            if (base?.tag !== DNS_NAME_TAG) return null;
            names.push(new TextDecoder().decode(der.subarray(base.start, base.end)));
        }
        return names;
    }
    return null;
}

function hex(fingerprint: string): string {
    return fingerprint.replaceAll(':', '').toUpperCase();
}

/**
 * Reads the dev CA and refuses anything a person should not trust: not a CA, or not name-constrained (critically) to
 * exactly the stack's domains. The mock engine's own `dev-ca` creates it that way; this checks the file on disk.
 */
export function inspectDevCa(certFile: string, pem: string): DevCaFacts {
    const certificate = new X509Certificate(pem);
    if (!certificate.ca) throw new Error(`${certFile} is not a CA certificate`);
    const names = permittedDnsNames(new Uint8Array(certificate.raw));
    const expected = [...DEV_CA_DOMAINS].sort();
    if (names === null || JSON.stringify([...names].sort()) !== JSON.stringify(expected)) {
        throw new Error(`${certFile} is not name-constrained to exactly ${expected.join(' and ')}`);
    }
    return { certFile, sha1: hex(certificate.fingerprint), sha256: hex(certificate.fingerprint256) };
}

/** `security find-certificate -Z` output: one `SHA-1 hash:` line per certificate. */
export function parseKeychainHashes(output: string): readonly string[] {
    return [...output.matchAll(/^SHA-1 hash: ([0-9A-F]{40})$/gm)].map((match) => match[1] ?? '');
}

function run(argv: readonly string[], capture: boolean): Promise<{ code: number; stdout: string }> {
    const [command, ...args] = argv;
    if (command === undefined) throw new Error('empty command');
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ['inherit', capture ? 'pipe' : 'inherit', capture ? 'ignore' : 'inherit'],
        });
        const chunks: Buffer[] = [];
        child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
        child.once('error', reject);
        child.once('close', (code) => {
            resolve({ code: code ?? 1, stdout: Buffer.concat(chunks).toString('utf8') });
        });
    });
}

async function fileState(path: string, expected: string): Promise<ResolverFileState> {
    try {
        return (await readFile(path, 'utf8')) === expected ? 'ours' : 'foreign';
    } catch {
        return 'absent';
    }
}

export function trustPlatform(platform: NodeJS.Platform): TrustPlatform {
    if (platform === 'darwin' || platform === 'linux') return platform;
    throw new Error(`dev:trust supports macOS and Linux, not ${platform}`);
}

export async function readTrustState(platform: TrustPlatform, home: string): Promise<TrustState> {
    let storedCas: readonly string[];
    let storeExists = true;
    if (platform === 'darwin') {
        const found = await run(
            ['security', 'find-certificate', '-a', '-c', DEV_CA_COMMON_NAME, '-Z', loginKeychain(home)],
            true,
        );
        storedCas = found.code === 0 ? parseKeychainHashes(found.stdout) : [];
    } else {
        const listed = await run(['certutil', '-L', '-d', nssDatabase(home), '-n', NSS_NICKNAME], true).catch(() => {
            throw new Error('certutil is missing: install libnss3-tools (Debian, Ubuntu) or nss-tools (Fedora)');
        });
        storedCas = listed.code === 0 ? [NSS_NICKNAME] : [];
        storeExists = await access(join(home, '.pki', 'nssdb', 'cert9.db')).then(
            () => true,
            () => false,
        );
    }
    const content = resolverContent(platform);
    const files = await Promise.all(
        resolverFiles(platform).map(async (path) => ({ path, state: await fileState(path, content) })),
    );
    return { storeExists, storedCas, resolverFiles: files };
}

/** Prints each step, then runs it unless `dryRun`; stops at the first that fails. */
export async function runSteps(steps: readonly TrustStep[], dryRun: boolean): Promise<boolean> {
    for (const step of steps) {
        process.stdout.write(`dev:trust: ${step.description}\n  $ ${shellLine(step.argv)}\n`);
        if (dryRun) continue;
        const { code } = await run(step.argv, false);
        if (code !== 0) {
            process.stderr.write(`dev:trust: that step failed (exit ${String(code)})\n`);
            return false;
        }
    }
    return true;
}

import { X509Certificate, createHash } from 'node:crypto';
import { connect as netConnect } from 'node:net';
import { Duplex } from 'node:stream';
import { connect as tlsConnect } from 'node:tls';

/** Lowercase hex SHA-256 of a certificate's DER bytes: the fingerprint every check in this harness compares. */
export function sha256Hex(der: Uint8Array): string {
    return createHash('sha256').update(der).digest('hex');
}

export function certificateSha256(certificate: X509Certificate): string {
    return sha256Hex(certificate.raw);
}

/** The leaf of CDP's `Network.getCertificate`, whose `tableNames` are the chain as base64 DER, leaf first. */
export function leafFromCdpChain(tableNames: readonly string[]): X509Certificate {
    const [leaf] = tableNames;
    if (leaf === undefined) throw new Error('the browser reported no certificate for this origin');
    return new X509Certificate(Buffer.from(leaf, 'base64'));
}

/** The common name of an X.509 subject or issuer as Node prints it (`CN=...` lines). */
export function commonName(distinguishedName: string): string | undefined {
    for (const line of distinguishedName.split('\n')) {
        if (line.startsWith('CN=')) return line.slice(3);
    }
    return undefined;
}

export interface TlsPeerOptions {
    readonly address: string;
    readonly port: number;
    readonly servername: string;
    /** PEM roots; the peer must chain to one of them and match `servername`. */
    readonly ca: string;
    readonly timeoutMs?: number;
}

/** The certificate a verifying TLS client sees at `address` when it asks for `servername`. */
export function tlsPeerCertificate(options: TlsPeerOptions): Promise<X509Certificate> {
    return new Promise((resolve, reject) => {
        const socket = tlsConnect({
            host: options.address,
            port: options.port,
            servername: options.servername,
            ca: options.ca,
            ALPNProtocols: ['http/1.1'],
            timeout: options.timeoutMs ?? 5_000,
        });
        socket.once('secureConnect', () => {
            const peer = socket.getPeerX509Certificate();
            socket.end();
            if (peer === undefined) reject(new Error(`no peer certificate from ${options.servername}`));
            else resolve(peer);
        });
        socket.once('timeout', () => socket.destroy(new Error(`TLS to ${options.servername} timed out`)));
        socket.once('error', reject);
    });
}

export interface RawTlsOutcome {
    /** `closed`: the far side hung up; `handshake`: it completed TLS; `timeout`: it neither answered nor closed. */
    readonly kind: 'closed' | 'handshake' | 'timeout';
    /** Bytes that came back on the wire, before any decryption. */
    readonly bytesReceived: number;
}

/**
 * Sends a ClientHello for `servername` and counts the raw bytes that come back. A relay that refuses an SNI must
 * close without writing a byte, so it never acts as a TLS endpoint for a name it does not own.
 */
export function rawTlsAttempt(options: Omit<TlsPeerOptions, 'ca'>): Promise<RawTlsOutcome> {
    return new Promise((resolve) => {
        const raw = netConnect({ host: options.address, port: options.port });
        let bytesReceived = 0;
        const counted = new Duplex({
            read() {
                // Pushed from the raw socket's data events below.
            },
            write(chunk: Buffer, _encoding, callback) {
                raw.write(chunk, callback);
            },
            final(callback) {
                raw.end();
                callback();
            },
        });
        raw.on('data', (chunk: Buffer) => {
            bytesReceived += chunk.length;
            counted.push(chunk);
        });
        raw.once('end', () => counted.push(null));
        const socket = tlsConnect({ socket: counted, servername: options.servername, rejectUnauthorized: false });
        let settled = false;
        const settle = (kind: RawTlsOutcome['kind']): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            raw.destroy();
            resolve({ kind, bytesReceived });
        };
        const timer = setTimeout(() => {
            settle('timeout');
        }, options.timeoutMs ?? 5_000);
        socket.once('secureConnect', () => {
            settle('handshake');
        });
        socket.once('error', () => {
            settle('closed');
        });
        raw.once('close', () => {
            settle('closed');
        });
        raw.once('error', () => {
            settle('closed');
        });
    });
}

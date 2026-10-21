import type { X509Certificate } from 'node:crypto';
import { createHash, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
    KEY_USAGE,
    OID,
    basicConstraints,
    certificateExtensions,
    extendedKeyUsage,
    keyUsage,
    signCertificate,
    subjectAltName,
} from '../adapters/x509/certificate';
import { TAG, childrenOf, readDer } from '../adapters/x509/der';

/** RFC 8737 §3: the challenge certificate's critical extension holding SHA-256 of the key authorization. */
const ACME_IDENTIFIER_OID = '1.3.6.1.5.5.7.1.31';

/** Opens a TLS connection to `hostname` offering only `acme-tls/1`, as a CA's validation server would. */
export type AlpnValidator = (hostname: string) => Promise<X509Certificate>;

export interface FakeAcmeServerOptions {
    readonly validate: AlpnValidator;
    /** Challenge types offered per authorization; `tls-alpn-01` only by default. */
    readonly challengeTypes?: readonly string[];
    /** Hostnames whose authorization is already valid when the order is created (authorization reuse). */
    readonly preauthorized?: readonly string[];
    readonly lifetimeMs?: number;
}

export interface FakeAcmeServer {
    readonly directoryUrl: string;
    readonly caPem: string;
    /** `contact` of every account created. */
    readonly accounts: (readonly string[])[];
    /** One entry per validation: the hostname and whether the challenge certificate was right. */
    readonly validations: { readonly hostname: string; readonly valid: boolean }[];
    /** While true, new accounts are refused with an ACME `unauthorized` problem. */
    rejectAccounts: boolean;
    close(): Promise<void>;
}

interface Authz {
    readonly hostname: string;
    status: 'pending' | 'valid' | 'invalid';
    readonly token: string;
}

interface Order {
    readonly authzIds: readonly number[];
    readonly hostnames: readonly string[];
    status: 'pending' | 'ready' | 'valid' | 'invalid';
    certificate?: string;
}

const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

function jwkThumbprint(jwk: Record<string, unknown>): string {
    const canonical = JSON.stringify({ crv: jwk['crv'], kty: jwk['kty'], x: jwk['x'], y: jwk['y'] });
    return base64url(createHash('sha256').update(canonical).digest());
}

/** RFC 8737 checks on the certificate the validator saw: the name, and the critical `acmeIdentifier` digest. */
function challengeCertificateValid(certificate: X509Certificate, hostname: string, keyAuthorization: string): boolean {
    const extension = certificateExtensions(certificate.raw).get(ACME_IDENTIFIER_OID);
    if (extension?.critical !== true) return false;
    const digest = extension.value;
    const expected = createHash('sha256').update(keyAuthorization).digest();
    return (
        certificate.subjectAltName === `DNS:${hostname}` &&
        digest.tag === TAG.octetString &&
        digest.content.equals(expected)
    );
}

/** The SubjectPublicKeyInfo of a PKCS#10 request (its signature is not checked: this CA trusts its one client). */
function csrPublicKey(csrDer: Buffer) {
    const [info] = childrenOf(readDer(csrDer));
    const spki = info === undefined ? undefined : childrenOf(info)[2];
    if (spki === undefined) throw new Error('not a CSR');
    return createPublicKey({ key: spki.encoded, format: 'der', type: 'spki' });
}

/**
 * Just enough of RFC 8555 over plain HTTP for acme-client: directory, nonces, account, order, authorizations,
 * TLS-ALPN-01 challenges validated through `validate` before the challenge response returns (so the client's first
 * poll sees the outcome), finalization and download. JWS signatures are not verified; this is a test double for the
 * client's side of the flow, not a CA.
 */
export async function startFakeAcmeServer(options: FakeAcmeServerOptions): Promise<FakeAcmeServer> {
    const ca = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const now = Date.now();
    const caPem = signCertificate({
        subject: 'Fake ACME Root',
        issuer: 'Fake ACME Root',
        notBefore: new Date(now - 3_600_000),
        notAfter: new Date(now + 86_400_000),
        publicKey: ca.publicKey,
        issuerKey: ca.privateKey,
        extensions: [basicConstraints({ ca: true, pathLen: 0 }), keyUsage(KEY_USAGE.keyCertSign, KEY_USAGE.cRLSign)],
    });
    const authzs: Authz[] = [];
    const orders: Order[] = [];
    const accounts: (readonly string[])[] = [];
    const validations: { hostname: string; valid: boolean }[] = [];
    let thumbprint = '';
    let origin = '';
    const control = { rejectAccounts: false } as FakeAcmeServer;

    const authzJson = (id: number, authz: Authz) => ({
        status: authz.status,
        identifier: { type: 'dns', value: authz.hostname },
        challenges: (options.challengeTypes ?? ['tls-alpn-01']).map((type) => ({
            type,
            url: `${origin}/chall/${String(id)}`,
            token: authz.token,
            status: authz.status,
        })),
    });
    const orderJson = (id: number, order: Order) => ({
        status: order.status,
        identifiers: order.hostnames.map((value) => ({ type: 'dns', value })),
        authorizations: order.authzIds.map((authzId) => `${origin}/authz/${String(authzId)}`),
        finalize: `${origin}/finalize/${String(id)}`,
        ...(order.certificate === undefined ? {} : { certificate: `${origin}/cert/${String(id)}` }),
    });
    const refresh = (order: Order): void => {
        if (order.status === 'pending' && order.authzIds.every((id) => authzs[id]?.status === 'valid')) {
            order.status = 'ready';
        }
    };

    async function handle(request: IncomingMessage, body: Buffer, response: ServerResponse): Promise<void> {
        const send = (status: number, payload: unknown, headers: Record<string, string> = {}): void => {
            const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
            response.writeHead(status, {
                'replay-nonce': base64url(randomBytes(16)),
                'content-type': typeof payload === 'string' ? 'application/pem-certificate-chain' : 'application/json',
                ...headers,
            });
            response.end(text);
        };
        const path = request.url ?? '/';
        if (path === '/dir') {
            send(200, {
                newNonce: `${origin}/nonce`,
                newAccount: `${origin}/account`,
                newOrder: `${origin}/order`,
                revokeCert: `${origin}/revoke`,
                keyChange: `${origin}/key-change`,
            });
            return;
        }
        if (path === '/nonce') {
            send(200, '');
            return;
        }
        const jws = JSON.parse(body.toString('utf8')) as { protected: string; payload: string };
        const header = JSON.parse(Buffer.from(jws.protected, 'base64url').toString('utf8')) as {
            jwk?: Record<string, unknown>;
        };
        const payload = (
            jws.payload === '' ? {} : JSON.parse(Buffer.from(jws.payload, 'base64url').toString('utf8'))
        ) as Record<string, unknown>;
        const [, kind = '', idText = ''] = path.split('/');
        const id = Number(idText);
        switch (kind) {
            case 'account': {
                if (control.rejectAccounts) {
                    send(403, { type: 'urn:ietf:params:acme:error:unauthorized', detail: 'no accounts today' });
                    return;
                }
                if (header.jwk === undefined) throw new Error('newAccount without a jwk');
                thumbprint = jwkThumbprint(header.jwk);
                accounts.push((payload['contact'] as string[] | undefined) ?? []);
                send(201, { status: 'valid' }, { location: `${origin}/acct/1` });
                return;
            }
            case 'order': {
                const identifiers = payload['identifiers'] as { value: string }[];
                const authzIds = identifiers.map(({ value }) => {
                    const status = options.preauthorized?.includes(value) === true ? 'valid' : 'pending';
                    return authzs.push({ hostname: value, status, token: base64url(randomBytes(16)) }) - 1;
                });
                const order: Order = { authzIds, hostnames: identifiers.map(({ value }) => value), status: 'pending' };
                refresh(order);
                const orderId = orders.push(order) - 1;
                send(201, orderJson(orderId, order), { location: `${origin}/orders/${String(orderId)}` });
                return;
            }
            case 'authz': {
                const authz = authzs[id];
                if (authz === undefined) break;
                send(200, authzJson(id, authz));
                return;
            }
            case 'chall': {
                const authz = authzs[id];
                if (authz === undefined) break;
                if (authz.status === 'pending') {
                    const valid = await options.validate(authz.hostname).then(
                        (certificate) =>
                            challengeCertificateValid(certificate, authz.hostname, `${authz.token}.${thumbprint}`),
                        () => false,
                    );
                    validations.push({ hostname: authz.hostname, valid });
                    authz.status = valid ? 'valid' : 'invalid';
                }
                send(200, authzJson(id, authz).challenges[0]);
                return;
            }
            case 'orders':
            case 'finalize': {
                const order = orders[id];
                if (order === undefined) break;
                refresh(order);
                if (kind === 'finalize' && order.status === 'ready') {
                    const leaf = signCertificate({
                        subject: order.hostnames[0] ?? 'leaf',
                        issuer: 'Fake ACME Root',
                        notBefore: new Date(Date.now() - 60_000),
                        notAfter: new Date(Date.now() + (options.lifetimeMs ?? 86_400_000)),
                        publicKey: csrPublicKey(Buffer.from(payload['csr'] as string, 'base64url')),
                        issuerKey: ca.privateKey,
                        extensions: [
                            basicConstraints({ ca: false }),
                            keyUsage(KEY_USAGE.digitalSignature),
                            extendedKeyUsage(OID.serverAuth),
                            subjectAltName(order.hostnames),
                        ],
                    });
                    order.certificate = `${leaf}${caPem}`;
                    order.status = 'valid';
                }
                send(200, orderJson(id, order));
                return;
            }
            case 'cert': {
                const certificate = orders[id]?.certificate;
                if (certificate === undefined) break;
                send(200, certificate);
                return;
            }
        }
        send(404, { type: 'urn:ietf:params:acme:error:malformed', detail: 'not found' });
    }

    const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
            handle(request, Buffer.concat(chunks), response).catch(() => {
                response.writeHead(500).end();
            });
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    Object.assign(control, {
        directoryUrl: `${origin}/dir`,
        caPem,
        accounts,
        validations,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => {
                    resolve();
                });
            }),
    });
    return control;
}

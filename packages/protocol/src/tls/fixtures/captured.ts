import type { ClientHelloParse } from '../client-hello';
import { clientHello as chromium } from './chromium';
import { clientHello as curl } from './curl';
import { clientHello as firefox } from './firefox';
import { fromBase64 } from './from-base64';
import { clientHello as goAcmeTls } from './go-acme-tls';
import { clientHello as node } from './node';
import { clientHello as opensslNoServername } from './openssl-noservername';
import { clientHello as opensslServername } from './openssl-servername';
import { clientHello as webkit } from './webkit';

export interface CapturedClientHello {
    readonly name: string;
    readonly bytes: Uint8Array;
    readonly expected: ClientHelloParse;
}

const browserAlpn = ['h2', 'http/1.1'];

export const CAPTURED_CLIENT_HELLOS: readonly CapturedClientHello[] = [
    {
        name: 'chromium',
        bytes: fromBase64(chromium),
        expected: { kind: 'sni', hostname: 'engine.localhost', alpn: browserAlpn },
    },
    {
        name: 'firefox',
        bytes: fromBase64(firefox),
        expected: { kind: 'sni', hostname: 'engine.localhost', alpn: browserAlpn },
    },
    { name: 'webkit', bytes: fromBase64(webkit), expected: { kind: 'sni', hostname: 'localhost', alpn: browserAlpn } },
    {
        name: 'curl',
        bytes: fromBase64(curl),
        expected: { kind: 'sni', hostname: 'engine.localhost', alpn: browserAlpn },
    },
    {
        name: 'openssl-servername',
        bytes: fromBase64(opensslServername),
        expected: { kind: 'sni', hostname: 'engine.localhost', alpn: [] },
    },
    { name: 'openssl-noservername', bytes: fromBase64(opensslNoServername), expected: { kind: 'no-sni', alpn: [] } },
    { name: 'node', bytes: fromBase64(node), expected: { kind: 'sni', hostname: 'engine.localhost', alpn: [] } },
    {
        name: 'go-acme-tls',
        bytes: fromBase64(goAcmeTls),
        expected: { kind: 'sni', hostname: 'engine.localhost', alpn: ['acme-tls/1'] },
    },
];

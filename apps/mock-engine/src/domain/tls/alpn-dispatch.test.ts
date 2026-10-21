import { Hostname, parseClientHello } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { captureClientHello } from '../../testing/client-hello';
import type { CompleteClientHello } from './alpn-dispatch';
import { dispatchClientHello } from './alpn-dispatch';

const HOST = Hostname.parse('abcdefghijklmnopqrstuvwxyz.engine.test');
const OTHER = Hostname.parse('other.engine.test');

async function hello(servername: string | null, ALPNProtocols?: string[]): Promise<CompleteClientHello> {
    const parse = parseClientHello(
        await captureClientHello({ servername, ...(ALPNProtocols === undefined ? {} : { ALPNProtocols }) }),
        { maxBytes: 16_384 },
    );
    if (parse.kind === 'need-more') throw new Error('incomplete hello');
    return parse;
}

const pendingFor =
    (...hostnames: Hostname[]) =>
    (hostname: Hostname): boolean =>
        hostnames.includes(hostname);

describe('dispatchClientHello', () => {
    it('sends an acme-tls/1 hello with a pending challenge for its name to the responder', async () => {
        expect(dispatchClientHello(await hello(HOST, ['acme-tls/1']), pendingFor(HOST))).toEqual({
            kind: 'acme-challenge',
            hostname: HOST,
        });
    });

    it('rejects an acme-tls/1 hello without a pending challenge, or with one for another name', async () => {
        const acme = await hello(HOST, ['acme-tls/1']);
        expect(dispatchClientHello(acme, pendingFor())).toEqual({ kind: 'reject', reason: 'no-pending-challenge' });
        expect(dispatchClientHello(acme, pendingFor(OTHER))).toEqual({
            kind: 'reject',
            reason: 'no-pending-challenge',
        });
    });

    it('rejects acme-tls/1 offered next to another protocol, even with a challenge pending', async () => {
        expect(dispatchClientHello(await hello(HOST, ['http/1.1', 'acme-tls/1']), pendingFor(HOST))).toEqual({
            kind: 'reject',
            reason: 'acme-alpn-mixed',
        });
    });

    it('rejects acme-tls/1 without SNI', async () => {
        expect(dispatchClientHello(await hello(null, ['acme-tls/1']), pendingFor(HOST))).toEqual({
            kind: 'reject',
            reason: 'acme-without-sni',
        });
    });

    it('rejects acme-tls/1 for a name that is not a hostname the engine could hold', () => {
        const parse: CompleteClientHello = { kind: 'sni', hostname: 'localhost', alpn: ['acme-tls/1'] };
        expect(dispatchClientHello(parse, () => true)).toEqual({ kind: 'reject', reason: 'no-pending-challenge' });
    });

    it('passes a browser hello to the TLS server, challenge pending or not', async () => {
        const browser = await hello(HOST, ['h2', 'http/1.1']);
        expect(dispatchClientHello(browser, pendingFor())).toEqual({ kind: 'normal' });
        expect(dispatchClientHello(browser, pendingFor(HOST))).toEqual({ kind: 'normal' });
        expect(dispatchClientHello(await hello(HOST), pendingFor(HOST))).toEqual({ kind: 'normal' });
    });

    it('leaves a hello without SNI to the TLS server, which refuses it', async () => {
        expect(dispatchClientHello(await hello(null, ['http/1.1']), pendingFor(HOST))).toEqual({ kind: 'normal' });
    });

    it('rejects malformed and oversized hellos', () => {
        const http = parseClientHello(new TextEncoder().encode('GET / HTTP/1.1\r\n\r\n'), { maxBytes: 16_384 });
        if (http.kind === 'need-more') throw new Error('incomplete');
        expect(dispatchClientHello(http, pendingFor(HOST))).toEqual({ kind: 'reject', reason: 'malformed' });
        expect(dispatchClientHello({ kind: 'too-large' }, pendingFor(HOST))).toEqual({
            kind: 'reject',
            reason: 'too-large',
        });
    });
});

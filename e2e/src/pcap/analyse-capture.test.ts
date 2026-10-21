import { describe, expect, it } from 'vitest';

import type { CaptureAnalysisOptions } from './analyse-capture.ts';
import { analyseCapture } from './analyse-capture.ts';
import type { Endpoint } from './pcap.ts';
import { buildPcap, tcpConversation } from './testing/pcap-writer.ts';
import {
    APPLICATION_DATA,
    HANDSHAKE,
    clientHello,
    opaqueBytes,
    tls13ClientFlight,
    tls13ServerFlight,
    tlsRecord,
} from './testing/tls-fixtures.ts';

const CANARY = 'canary-5f0c2e9b71d4';
const OPTIONS: CaptureAnalysisOptions = {
    serverPort: 443,
    engineHostname: 'engine-1.relay.test',
    forbiddenPlaintext: [CANARY, 'HTTP/1.1', 'GET /', 'data: {'],
};
const RELAY: Endpoint = { address: '10.0.0.11', port: 443 };
const BROWSER: Endpoint = { address: '10.0.0.5', port: 51234 };
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function browserPort(port: number): Endpoint {
    return { address: BROWSER.address, port };
}

function engineConversation(client: Endpoint) {
    return tcpConversation({
        client,
        server: RELAY,
        messages: [
            { from: 'client', data: tls13ClientFlight('Engine-1.Relay.Test', []) },
            { from: 'server', data: tls13ServerFlight([2000, 300]) },
            { from: 'client', data: tlsRecord(APPLICATION_DATA, opaqueBytes(60)) },
            { from: 'client', data: tlsRecord(APPLICATION_DATA, opaqueBytes(500)) },
            { from: 'server', data: tlsRecord(APPLICATION_DATA, opaqueBytes(1200)) },
        ],
    });
}

function plaintextConversation(client: Endpoint, request: readonly string[]) {
    return tcpConversation({
        client,
        server: RELAY,
        messages: request.map((part) => ({ from: 'client' as const, data: encode(part) })),
    });
}

describe('analyseCapture', () => {
    it('passes a capture of TLS-only engine and other connections', () => {
        const analysis = analyseCapture(
            buildPcap([
                ...engineConversation(BROWSER),
                ...tcpConversation({
                    client: browserPort(51300),
                    server: RELAY,
                    messages: [
                        { from: 'client', data: tls13ClientFlight('dashboard.test', [80]) },
                        { from: 'server', data: tls13ServerFlight([100]) },
                    ],
                }),
            ]),
            OPTIONS,
        );

        expect(analysis).toMatchObject({ engineConnections: 1, problems: [], plaintextHits: [] });
        expect(analysis.connections).toMatchObject([
            {
                kind: 'engine',
                label: '10.0.0.5:51234 -> 10.0.0.11:443',
                sawHandshake: true,
                closed: true,
                clientToServerTls: { kind: 'tls', counts: { handshake: 1, changeCipherSpec: 1, applicationData: 2 } },
                serverToClientTls: { kind: 'tls', counts: { handshake: 1, changeCipherSpec: 1, applicationData: 3 } },
            },
            { kind: 'other-tls', hostname: 'dashboard.test' },
        ]);
    });

    it('finds a plaintext HTTP/1.1 request with the canary and flags its connection as not TLS', () => {
        const request = `GET /chat HTTP/1.1\r\nHost: engine-1.relay.test\r\n\r\n`;
        const upload = `POST /x HTTP/1.1\r\nContent-Length: 19\r\n\r\n`;
        const analysis = analyseCapture(
            buildPcap([
                ...engineConversation(BROWSER),
                ...plaintextConversation(browserPort(51400), [request, `${upload}${CANARY}`]),
            ]),
            OPTIONS,
        );

        expect(analysis.engineConnections).toBe(1);
        expect(analysis.connections[1]).toMatchObject({ kind: 'not-tls', clientHello: 'malformed' });
        const streamLabel = '10.0.0.5:51400 -> 10.0.0.11:443';
        expect(analysis.plaintextHits.filter((hit) => hit.label === streamLabel)).toEqual([
            { needle: CANARY, label: streamLabel, offset: request.length + upload.length },
            { needle: 'HTTP/1.1', label: streamLabel, offset: 10 },
            { needle: 'GET /', label: streamLabel, offset: 0 },
        ]);
        expect(analysis.plaintextHits).toContainEqual({
            needle: CANARY,
            label: 'segment 14 10.0.0.5:51400 -> 10.0.0.11:443',
            offset: upload.length,
        });
        expect(analysis.plaintextHits.every((hit) => hit.label.includes('51400'))).toBe(true);
    });

    it('finds a canary split across two segments only in the reassembled stream', () => {
        const half = CANARY.length / 2;
        const analysis = analyseCapture(
            buildPcap(plaintextConversation(BROWSER, [CANARY.slice(0, half), CANARY.slice(half)])),
            OPTIONS,
        );

        expect(analysis.plaintextHits).toEqual([
            { needle: CANARY, label: '10.0.0.5:51234 -> 10.0.0.11:443', offset: 0 },
        ]);
    });

    it('searches connections on other ports and the server direction', () => {
        const analysis = analyseCapture(
            buildPcap(
                tcpConversation({
                    client: BROWSER,
                    server: { address: RELAY.address, port: 8080 },
                    messages: [{ from: 'server', data: encode(`data: {"text":"${CANARY}"}`) }],
                }),
            ),
            OPTIONS,
        );

        expect(analysis.connections).toEqual([]);
        expect(analysis.plaintextHits.map((hit) => [hit.needle, hit.label])).toEqual([
            [CANARY, 'segment 3 10.0.0.11:8080 -> 10.0.0.5:51234'],
            ['data: {', 'segment 3 10.0.0.11:8080 -> 10.0.0.5:51234'],
            [CANARY, '10.0.0.11:8080 -> 10.0.0.5:51234'],
            ['data: {', '10.0.0.11:8080 -> 10.0.0.5:51234'],
        ]);
    });

    it('reports an engine connection that switches to a plaintext record type, without printing its bytes', () => {
        const hello = clientHello('engine-1.relay.test');
        const analysis = analyseCapture(
            buildPcap(
                tcpConversation({
                    client: BROWSER,
                    server: RELAY,
                    messages: [
                        { from: 'client', data: hello },
                        { from: 'server', data: tls13ServerFlight([100]) },
                        { from: 'client', data: encode(`GxT ${CANARY}`) },
                    ],
                }),
            ),
            { ...OPTIONS, forbiddenPlaintext: ['unrelated'] },
        );

        expect(analysis.engineConnections).toBe(1);
        expect(analysis.problems).toEqual([
            `10.0.0.5:51234 -> 10.0.0.11:443 (client to server): record header at offset ${String(hello.byteLength)} has a content type outside 20-23`,
        ]);
        expect(analysis.problems.join('\n')).not.toContain(CANARY);
    });

    it('reports a handshake record after application data on an engine connection', () => {
        const analysis = analyseCapture(
            buildPcap(
                tcpConversation({
                    client: BROWSER,
                    server: RELAY,
                    messages: [
                        { from: 'client', data: tls13ClientFlight('engine-1.relay.test', [50]) },
                        { from: 'server', data: tls13ServerFlight([100]) },
                        { from: 'server', data: tlsRecord(HANDSHAKE, opaqueBytes(30)) },
                    ],
                }),
            ),
            OPTIONS,
        );

        expect(analysis.problems).toEqual([
            expect.stringMatching(
                /^10\.0\.0\.5:51234 -> 10\.0\.0\.11:443 \(server to client\): record at offset \d+ is not application data/,
            ),
        ]);
    });

    it('accepts an engine stream cut mid-record but reports a hole in it', () => {
        const serverFlight = tls13ServerFlight([2000]);
        const packets = tcpConversation({
            client: BROWSER,
            server: RELAY,
            messages: [
                { from: 'client', data: tls13ClientFlight('engine-1.relay.test', [50]) },
                { from: 'server', data: serverFlight.subarray(0, 1000) },
                { from: 'server', data: serverFlight.subarray(1000, 1500) },
                { from: 'server', data: serverFlight.subarray(1500, 1800) },
            ],
            close: false,
        });
        const cutAtEnd = analyseCapture(buildPcap(packets), OPTIONS);
        const withHole = analyseCapture(buildPcap(packets.filter((_, index) => index !== 5)), OPTIONS);

        expect(cutAtEnd.problems).toEqual([]);
        expect(cutAtEnd.connections[0]).toMatchObject({ serverToClientTls: { kind: 'tls', truncatedTail: true } });
        expect(withHole.problems).toEqual([
            '10.0.0.5:51234 -> 10.0.0.11:443 (server to client): 500 bytes missing from the capture at offset 1000',
        ]);
    });

    it('reports an engine connection whose server never answered', () => {
        const analysis = analyseCapture(
            buildPcap(
                tcpConversation({
                    client: BROWSER,
                    server: RELAY,
                    messages: [{ from: 'client', data: clientHello('engine-1.relay.test') }],
                }),
            ),
            OPTIONS,
        );

        expect(analysis.problems).toEqual([
            '10.0.0.5:51234 -> 10.0.0.11:443 (server to client): stream holds no complete TLS record',
        ]);
    });

    it('labels repeated connections on one 4-tuple apart', () => {
        const analysis = analyseCapture(
            buildPcap([...engineConversation(BROWSER), ...plaintextConversation(BROWSER, ['GET / HTTP/1.1'])]),
            OPTIONS,
        );

        expect(analysis.connections.map((connection) => connection.label)).toEqual([
            '10.0.0.5:51234 -> 10.0.0.11:443',
            '10.0.0.5:51234 -> 10.0.0.11:443 #2',
        ]);
        expect(analysis.plaintextHits.filter((hit) => !hit.label.startsWith('segment'))).toEqual([
            { needle: 'HTTP/1.1', label: '10.0.0.5:51234 -> 10.0.0.11:443 #2', offset: 6 },
            { needle: 'GET /', label: '10.0.0.5:51234 -> 10.0.0.11:443 #2', offset: 0 },
        ]);
    });

    it('reports a file it cannot read', () => {
        expect(analyseCapture(Uint8Array.of(0x0a, 0x0d, 0x0d, 0x0a, 0, 0, 0, 0), OPTIONS)).toEqual({
            engineConnections: 0,
            connections: [],
            problems: ['capture is not a supported pcap file (pcapng)'],
            plaintextHits: [],
        });
    });

    it('reports packets it could not decode', () => {
        const file = buildPcap(engineConversation(BROWSER));
        file[24 + 16 + 14] = 0x44;

        expect(analyseCapture(file, OPTIONS).problems).toEqual([
            'packets with malformed IP or TCP headers went unchecked: 1',
        ]);
    });
});

import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { ResponseReader, requestBytes } from './http1';

function feed(...chunks: string[]): PassThrough {
    const stream = new PassThrough();
    for (const chunk of chunks) stream.write(chunk);
    return stream;
}

describe('ResponseReader', () => {
    it('reads Content-Length, chunked and empty bodies across chunks', async () => {
        const stream = feed(
            'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nh',
            'iHTTP/1.1 201 Created\r\nTransfer-Encoding: chunked\r\n\r\n',
        );
        const reader = new ResponseReader(stream);
        const first = await reader.next(100);
        expect(first.kind === 'ok' && first.response.body.toString()).toBe('hi');
        stream.write('3;ext=1\r\nabc\r\n0\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n');
        const second = await reader.next(100);
        expect(second.kind === 'ok' && [second.response.status, second.response.body.toString()]).toEqual([201, 'abc']);
        const third = await reader.next(100);
        expect(third.kind === 'ok' && third.response.status).toBe(204);
        expect(await reader.next(5)).toMatchObject({ kind: 'failed', timedOut: true });
    });

    it('waits for the rest of a chunked body and takes a body-less answer as empty', async () => {
        const stream = feed('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n', '4\r\nab');
        const reader = new ResponseReader(stream);
        const pending = reader.next(500);
        stream.write('cd\r\n');
        stream.write('0\r\n');
        stream.write('\r\nHTTP/1.1 200 OK\r\n\r\n');
        const chunked = await pending;
        expect(chunked.kind === 'ok' && chunked.response.body.toString()).toBe('abcd');
        const empty = await reader.next(100);
        expect(empty.kind === 'ok' && empty.response.body.length).toBe(0);
        const partial = new ResponseReader(feed('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4'));
        expect(await partial.next(20)).toMatchObject({ kind: 'failed', timedOut: true });
    });

    it('refuses what is not HTTP/1.1 and reports a connection that ends', async () => {
        for (const bad of [
            'SSH-2.0-x\r\n\r\n',
            'HTTP/1.1 200 OK\r\nno-colon\r\n\r\n',
            'HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n',
            'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n',
            `HTTP/1.1 200 OK\r\nX: ${'a'.repeat(70_000)}`,
        ]) {
            expect(await new ResponseReader(feed(bad)).next(50)).toMatchObject({ kind: 'failed', timedOut: false });
        }
        const ended = feed('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort');
        const reader = new ResponseReader(ended);
        ended.end();
        expect(await reader.next(100)).toMatchObject({ kind: 'failed', timedOut: false });
        const broken = feed();
        const brokenReader = new ResponseReader(broken);
        broken.destroy(new Error('boom'));
        expect(await brokenReader.next(100)).toMatchObject({ kind: 'failed', reason: 'connection error (Error)' });
    });

    it('writes a request with Host, Connection and extra headers', () => {
        expect(
            requestBytes({
                host: 'e.localhost',
                path: '/x',
                close: true,
                method: 'HEAD',
                headers: { A: 'b' },
            }).toString(),
        ).toBe(
            'HEAD /x HTTP/1.1\r\nHost: e.localhost\r\nAccept: application/json\r\nConnection: close\r\nA: b\r\n\r\n',
        );
    });
});

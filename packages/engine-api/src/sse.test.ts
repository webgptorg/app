import { describe, expect, it } from 'vitest';
import { createSseParser, encodeSseMessage, parseSseStream, type SseMessage } from './sse';

const encoder = new TextEncoder();

function parseAll(text: string, maxLineLength?: number): SseMessage[] {
    const parser = createSseParser(maxLineLength === undefined ? {} : { maxLineLength });
    return [...parser.push(encoder.encode(text)), ...parser.end()];
}

function parseChunks(chunks: readonly Uint8Array[]): SseMessage[] {
    const parser = createSseParser();
    const out = chunks.flatMap((chunk) => parser.push(chunk));
    return [...out, ...parser.end()];
}

function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

type Random = () => number;

function int(random: Random, maxExclusive: number): number {
    return Math.floor(random() * maxExclusive);
}

function pick<T>(random: Random, items: readonly T[]): T {
    const item = items[int(random, items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
}

const TEXT_POOL = ['a', 'Z', '0', ' ', ':', '{', '"', 'é', '中', '😀', '𝄞', ' ', 'data', 'id'];

function randomText(random: Random, maxLength: number, allowNewline: boolean): string {
    let out = '';
    const length = int(random, maxLength + 1);
    for (let i = 0; i < length; i++) out += allowNewline && random() < 0.1 ? '\n' : pick(random, TEXT_POOL);
    return out;
}

function randomSplits(random: Random, bytes: Uint8Array): Uint8Array[] {
    const chunks: Uint8Array[] = [];
    let start = 0;
    while (start < bytes.length) {
        const size = 1 + int(random, Math.min(16, bytes.length - start));
        chunks.push(bytes.subarray(start, start + size));
        start += size;
    }
    return chunks;
}

interface GeneratedStream {
    readonly text: string;
    readonly expected: SseMessage[];
}

function randomStream(random: Random): GeneratedStream {
    let text = random() < 0.3 ? '﻿' : '';
    const expected: SseMessage[] = [];
    let lastId: string | null = null;
    const count = int(random, 6);
    for (let i = 0; i < count; i++) {
        if (random() < 0.3) text += `:${randomText(random, 8, false)}\n`;
        const event = random() < 0.2 ? 'message' : `e${randomText(random, 6, false)}`;
        const data = randomText(random, 40, true);
        const id = random() < 0.5 ? randomText(random, 6, false) : undefined;
        if (id !== undefined) lastId = id;
        text += encodeSseMessage(id === undefined ? { event, data } : { event, data, id });
        expected.push({ event: event === '' ? 'message' : event, data, id: lastId });
    }
    const ending = pick(random, ['\n', '\r\n', '\r']);
    return { text: text.replaceAll('\n', ending), expected };
}

describe('createSseParser', () => {
    it('parses an event with the default type', () => {
        expect(parseAll('data: hello\n\n')).toEqual([{ event: 'message', data: 'hello', id: null }]);
    });

    it('joins multi-line data and reads the event type', () => {
        expect(parseAll('event: delta\ndata: a\ndata:b\n\n')).toEqual([{ event: 'delta', data: 'a\nb', id: null }]);
    });

    it('ignores comments, retry and unknown fields', () => {
        expect(parseAll(': ping\nretry: 10\nfoo: bar\ndata: x\n\n')).toEqual([
            { event: 'message', data: 'x', id: null },
        ]);
    });

    it('treats a field without a colon as an empty value', () => {
        expect(parseAll('data\n\n')).toEqual([{ event: 'message', data: '', id: null }]);
    });

    it('strips exactly one leading space', () => {
        expect(parseAll('data:  x\n\n')).toEqual([{ event: 'message', data: ' x', id: null }]);
    });

    it('keeps the last event id across events and ignores ids containing NUL', () => {
        expect(parseAll('id: 1\ndata: a\n\ndata: b\n\nid: 2\0\ndata: c\n\nid\ndata: d\n\n')).toEqual([
            { event: 'message', data: 'a', id: '1' },
            { event: 'message', data: 'b', id: '1' },
            { event: 'message', data: 'c', id: '1' },
            { event: 'message', data: 'd', id: '' },
        ]);
    });

    it('does not dispatch an event without data and resets its type', () => {
        expect(parseAll('event: x\n\ndata: y\n\n')).toEqual([{ event: 'message', data: 'y', id: null }]);
    });

    it('discards an incomplete event at the end of the stream', () => {
        expect(parseAll('data: a\n\ndata: b\n')).toEqual([{ event: 'message', data: 'a', id: null }]);
    });

    it('strips only one leading BOM', () => {
        expect(parseAll('﻿data: a\n\n')).toEqual([{ event: 'message', data: 'a', id: null }]);
        expect(parseAll('﻿﻿data: a\n\n')).toEqual([]);
    });

    it('accepts CRLF, CR and LF line endings', () => {
        const expected = [{ event: 'message', data: 'a\nb', id: null }];
        expect(parseAll('data: a\r\ndata: b\r\n\r\n')).toEqual(expected);
        expect(parseAll('data: a\rdata: b\r\r')).toEqual(expected);
    });

    it('treats a CR at the end of a chunk and an LF at the start of the next as one line break', () => {
        const parser = createSseParser();
        expect(parser.push(encoder.encode('data: a\r'))).toEqual([]);
        expect(parser.push(encoder.encode('\ndata: b\r'))).toEqual([]);
        expect(parser.push(encoder.encode('\n\r\n'))).toEqual([{ event: 'message', data: 'a\nb', id: null }]);
    });

    it('decodes a UTF-8 sequence split across chunks', () => {
        const bytes = encoder.encode('data: 😀\n\n');
        expect(parseChunks([bytes.subarray(0, 8), bytes.subarray(8)])).toEqual([
            { event: 'message', data: '😀', id: null },
        ]);
    });

    it('drops an over-long line together with its event', () => {
        const long = `data: ${'x'.repeat(20)}`;
        expect(parseAll(`data: ok\n\nid: 7\n${long}\ndata: y\n\ndata: z\n\n`, 10)).toEqual([
            { event: 'message', data: 'ok', id: null },
            { event: 'message', data: 'z', id: '7' },
        ]);
    });

    it('drops an over-long line that arrives in many chunks', () => {
        const parser = createSseParser({ maxLineLength: 10 });
        const out = [
            ...parser.push(encoder.encode('data: 12345')),
            ...parser.push(encoder.encode('67890')),
            ...parser.push(encoder.encode('abc\n\ndata: ok\n\n')),
        ];
        expect(out).toEqual([{ event: 'message', data: 'ok', id: null }]);
    });
});

describe('createSseParser properties', () => {
    it('yields the same events however a valid stream is split', () => {
        const random = mulberry32(0x5ee);
        for (let i = 0; i < 400; i++) {
            const { text, expected } = randomStream(random);
            const bytes = encoder.encode(text);
            expect(parseChunks([bytes])).toEqual(expected);
            expect(parseChunks(randomSplits(random, bytes))).toEqual(expected);
        }
    });

    it('never throws on arbitrary bytes and is split-invariant', () => {
        const random = mulberry32(0xbad);
        const fragments = ['data:', 'event:', 'id:', ':', ' ', '\r', '\n', '\r\n', '\0', 'x'].map((s) =>
            encoder.encode(s),
        );
        for (let i = 0; i < 400; i++) {
            const parts: number[] = [];
            const length = int(random, 200);
            for (let j = 0; j < length; j++) {
                if (random() < 0.5) parts.push(int(random, 256));
                else parts.push(...pick(random, fragments));
            }
            const bytes = Uint8Array.from(parts);
            const whole = parseChunks([bytes]);
            expect(parseChunks(randomSplits(random, bytes))).toEqual(whole);
        }
    });

    it('round-trips encoded messages', () => {
        const random = mulberry32(0xc0de);
        for (let i = 0; i < 400; i++) {
            const event = `e${randomText(random, 10, false)}`;
            const data = randomText(random, 60, true);
            const id = randomText(random, 10, false);
            expect(parseAll(encodeSseMessage({ event, data, id }))).toEqual([{ event, data, id }]);
        }
    });
});

describe('encodeSseMessage', () => {
    it('writes one data line per line of data', () => {
        expect(encodeSseMessage({ event: 'delta', data: 'a\nb', id: '3' })).toBe(
            'id: 3\nevent: delta\ndata: a\ndata: b\n\n',
        );
    });

    it('rejects line breaks in the event name or id and NUL in the id', () => {
        expect(() => encodeSseMessage({ event: 'a\nb', data: '' })).toThrow();
        expect(() => encodeSseMessage({ event: 'a\rb', data: '' })).toThrow();
        expect(() => encodeSseMessage({ event: 'a', data: '', id: '1\n' })).toThrow();
        expect(() => encodeSseMessage({ event: 'a', data: '', id: '1\0' })).toThrow();
    });
});

describe('parseSseStream', () => {
    async function collect(iterable: AsyncIterable<SseMessage>): Promise<SseMessage[]> {
        const out: SseMessage[] = [];
        for await (const message of iterable) out.push(message);
        return out;
    }

    function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
        return new ReadableStream<Uint8Array>({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
                controller.close();
            },
        });
    }

    it('yields every event of the stream', async () => {
        await expect(collect(parseSseStream(streamOf(['data: a\n', '\ndata: b\n\n'])))).resolves.toEqual([
            { event: 'message', data: 'a', id: null },
            { event: 'message', data: 'b', id: null },
        ]);
    });

    it('stops with the abort reason and cancels the stream when aborted', async () => {
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('data: first\n\n'));
            },
            cancel() {
                cancelled = true;
            },
        });
        const controller = new AbortController();
        const iterator = parseSseStream(stream, controller.signal)[Symbol.asyncIterator]();
        await expect(iterator.next()).resolves.toEqual({
            done: false,
            value: { event: 'message', data: 'first', id: null },
        });
        const pending = iterator.next();
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(cancelled).toBe(true);
    });

    it('rejects at once for an already aborted signal', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(collect(parseSseStream(streamOf(['data: a\n\n']), controller.signal))).rejects.toMatchObject({
            name: 'AbortError',
        });
    });

    it('cancels the stream when the consumer stops early', async () => {
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('data: a\n\ndata: b\n\n'));
            },
            cancel() {
                cancelled = true;
            },
        });
        for await (const message of parseSseStream(stream)) {
            expect(message.data).toBe('a');
            break;
        }
        expect(cancelled).toBe(true);
    });

    it('propagates a stream error', async () => {
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.error(new Error('connection reset'));
            },
        });
        await expect(collect(parseSseStream(stream))).rejects.toThrow('connection reset');
    });
});

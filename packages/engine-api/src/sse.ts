/** One dispatched server-sent event, parsed by the WHATWG EventSource rules. */
export interface SseMessage {
    /** The `event` field, or `'message'` when the event had none. */
    readonly event: string;
    readonly data: string;
    /** The last-event-ID buffer at dispatch: it persists across events, `null` until an `id` field sets it. */
    readonly id: string | null;
}

export interface SseParser {
    push(chunk: Uint8Array): SseMessage[];
    /** Flushes the decoder; an event without its closing blank line is discarded, as the spec requires. */
    end(): SseMessage[];
}

export interface SseParserOptions {
    readonly maxLineLength?: number;
}

/** Longest line (in UTF-16 code units) the parser buffers; longer lines are dropped with their event. */
export const SSE_MAX_LINE_LENGTH = 1_048_576;

const LF = 0x0a;
const CR = 0x0d;

export function createSseParser(options: SseParserOptions = {}): SseParser {
    const maxLineLength = options.maxLineLength ?? SSE_MAX_LINE_LENGTH;
    // The default (non-fatal) decoder strips one leading BOM and decodes identically however the bytes are split.
    let decoder = new TextDecoder('utf-8');
    let line = '';
    let lineTooLong = false;
    let discardingEvent = false;
    let skipLfAfterCr = false;
    let data = '';
    let eventType = '';
    let lastEventId: string | null = null;

    function resetEvent(): void {
        data = '';
        eventType = '';
        discardingEvent = false;
    }

    function appendToLine(text: string): void {
        if (lineTooLong || text.length === 0) return;
        if (line.length + text.length > maxLineLength) {
            lineTooLong = true;
            line = '';
            return;
        }
        line += text;
    }

    function finishLine(out: SseMessage[]): void {
        const current = line;
        line = '';
        if (lineTooLong) {
            lineTooLong = false;
            discardingEvent = true;
            return;
        }
        if (current === '') {
            dispatch(out);
            return;
        }
        if (discardingEvent || current.startsWith(':')) return;
        const colon = current.indexOf(':');
        const field = colon === -1 ? current : current.slice(0, colon);
        let value = colon === -1 ? '' : current.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        switch (field) {
            case 'event':
                eventType = value;
                break;
            case 'data':
                data += `${value}\n`;
                break;
            case 'id':
                if (!value.includes('\0')) lastEventId = value;
                break;
            default:
                // `retry` included: reconnecting is the caller's job, not the parser's.
                break;
        }
    }

    function dispatch(out: SseMessage[]): void {
        if (discardingEvent || data === '') {
            resetEvent();
            return;
        }
        out.push({ event: eventType === '' ? 'message' : eventType, data: data.slice(0, -1), id: lastEventId });
        resetEvent();
    }

    function process(text: string): SseMessage[] {
        const out: SseMessage[] = [];
        let start = 0;
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            if (skipLfAfterCr) {
                skipLfAfterCr = false;
                if (code === LF) {
                    start = i + 1;
                    continue;
                }
            }
            if (code === CR || code === LF) {
                appendToLine(text.slice(start, i));
                finishLine(out);
                // A CR may be the first half of a CRLF split across two chunks.
                skipLfAfterCr = code === CR;
                start = i + 1;
            }
        }
        appendToLine(text.slice(start));
        return out;
    }

    return {
        push(chunk) {
            return process(decoder.decode(chunk, { stream: true }));
        },
        end() {
            const out = process(decoder.decode());
            decoder = new TextDecoder('utf-8');
            line = '';
            lineTooLong = false;
            skipLfAfterCr = false;
            resetEvent();
            return out;
        },
    };
}

/** Reads `stream` to the end; aborting `signal` cancels the stream and rejects with the abort reason. */
export async function* parseSseStream(
    stream: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
): AsyncIterable<SseMessage> {
    signal?.throwIfAborted();
    const reader = stream.getReader();
    const parser = createSseParser();
    let finished = false;
    const onAbort = (): void => {
        reader.cancel(signal?.reason).catch(() => undefined);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        for (;;) {
            const result = await reader.read();
            signal?.throwIfAborted();
            if (result.done) {
                finished = true;
                for (const message of parser.end()) yield message;
                return;
            }
            for (const message of parser.push(result.value)) {
                signal?.throwIfAborted();
                yield message;
            }
        }
    } finally {
        signal?.removeEventListener('abort', onAbort);
        // An early return or an abort must release the underlying connection, not just stop reading.
        if (!finished) await reader.cancel(signal?.reason).catch(() => undefined);
        reader.releaseLock();
    }
}

export interface SseMessageToEncode {
    readonly event: string;
    readonly data: string;
    readonly id?: string;
}

/**
 * Encodes one event for a server. Line breaks inside `data` become separate `data:` lines, so CR and CRLF
 * come back as LF. A line break in `event` or `id` (or NUL in `id`) would corrupt the stream, so it throws.
 */
export function encodeSseMessage(message: SseMessageToEncode): string {
    if (/[\r\n]/.test(message.event)) throw new Error('SSE event name must not contain a line break');
    let out = '';
    if (message.id !== undefined) {
        if (/[\r\n\0]/.test(message.id)) throw new Error('SSE event id must not contain a line break or NUL');
        out += `id: ${message.id}\n`;
    }
    out += `event: ${message.event}\n`;
    for (const dataLine of message.data.split(/\r\n|\r|\n/)) out += `data: ${dataLine}\n`;
    return `${out}\n`;
}

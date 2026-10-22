/*
 * Records the text of every response a browser context receives, so the secrets, integrations and chat flows can prove
 * a canary never came back from the engine. One helper for all of them (X-04). Only text-like bodies are read: a
 * binary download cannot carry the canary as text, and reading it would only slow the test down.
 */
import type { BrowserContext, Response } from '@playwright/test';

export interface RecordedResponse {
    readonly url: string;
    readonly status: number;
    readonly contentType: string;
    readonly body: string;
}

export interface ResponseRecorder {
    /** Every text-like response read so far, after waiting up to `settleMs` for bodies still arriving. */
    settled(settleMs?: number): Promise<readonly RecordedResponse[]>;
    /** Responses whose body never finished within the settle time: open streams such as `GET /events`. */
    readonly unfinished: () => readonly string[];
}

const TEXT_LIKE = /^(?:text\/|application\/(?:[\w.+-]*\+)?(?:json|javascript|xml)\b)/i;
const DEFAULT_SETTLE_MS = 2_000;

export function isTextLike(contentType: string): boolean {
    return TEXT_LIKE.test(contentType.trim());
}

/** Where `needle` occurs in the recorded responses, as `<url> (<status>)`. */
export function responsesContaining(responses: readonly RecordedResponse[], needle: string): readonly string[] {
    return responses
        .filter((response) => response.body.includes(needle))
        .map((response) => `${response.url} (${String(response.status)})`);
}

export function recordResponses(context: BrowserContext): ResponseRecorder {
    const pending = new Map<Response, Promise<RecordedResponse | null>>();
    const read = async (response: Response): Promise<RecordedResponse | null> => {
        const contentType = (await response.headerValue('content-type')) ?? '';
        if (!isTextLike(contentType)) return null;
        // A redirect or a body the page dropped (navigation) has nothing left to read.
        const body = await response.text().catch(() => null);
        if (body === null) return null;
        return { url: response.url(), status: response.status(), contentType, body };
    };
    context.on('response', (response) => {
        pending.set(response, read(response));
    });
    let unfinished: string[] = [];
    return {
        async settled(settleMs = DEFAULT_SETTLE_MS) {
            const deadline = new Promise<'open'>((resolve) => {
                setTimeout(() => {
                    resolve('open');
                }, settleMs);
            });
            const results = await Promise.all(
                [...pending].map(async ([response, body]) => ({
                    response,
                    result: await Promise.race([body, deadline]),
                })),
            );
            unfinished = results.filter(({ result }) => result === 'open').map(({ response }) => response.url());
            return results.flatMap(({ result }) => (result === 'open' || result === null ? [] : [result]));
        },
        unfinished: () => unfinished,
    };
}

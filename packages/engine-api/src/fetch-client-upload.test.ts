import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UploadProgress } from './client';
import { ENGINE_API_PREFIX } from './constants';
import { createFetchEngineApiClient } from './fetch-client';
import { createProblem } from './problem';

const BASE_URL = 'https://engine.example';
const UPLOAD_URL = `${BASE_URL}${ENGINE_API_PREFIX}/files`;
const AT = '2026-10-19T12:00:00Z';

const fileMetadata = {
    id: 'f1',
    name: 'notes.txt',
    contentType: 'text/plain',
    sizeBytes: 5,
    sha256: 'a'.repeat(64),
    purpose: 'knowledge',
    agentId: null,
    chatId: null,
    runId: null,
    scan: { status: 'pending', checkedAt: null },
    versionCount: 1,
    createdBy: 'm1',
    createdAt: AT,
};

interface XhrAnswer {
    readonly status: number;
    readonly body?: string;
    readonly contentType?: string;
    readonly responseURL?: string;
}

/** Just enough of `XMLHttpRequest` for the client; the test decides when bytes move and when it answers. */
class FakeXhr extends EventTarget {
    readonly upload = new EventTarget();
    readonly headers = new Map<string, string>();
    method = '';
    url = '';
    body: Blob | null = null;
    responseType = '';
    responseURL = '';
    status = 0;
    response: Blob | null = null;
    aborted = false;
    private responseHeaders = '';

    open(method: string, url: string): void {
        this.method = method;
        this.url = url;
    }

    setRequestHeader(name: string, value: string): void {
        this.headers.set(name, value);
    }

    send(body: Blob): void {
        this.body = body;
    }

    abort(): void {
        this.aborted = true;
        this.dispatchEvent(new Event('abort'));
    }

    getAllResponseHeaders(): string {
        return this.responseHeaders;
    }

    progress(loaded: number): void {
        const event = Object.assign(new Event('progress'), { loaded, total: this.body?.size ?? 0 });
        this.upload.dispatchEvent(event);
    }

    answer({ status, body = '', contentType = 'application/json', responseURL = this.url }: XhrAnswer): void {
        this.status = status;
        this.responseURL = responseURL;
        this.response = new Blob([body]);
        this.responseHeaders = `content-type: ${contentType}\r\nx-other: 1\r\n`;
        this.dispatchEvent(new Event('load'));
    }

    fail(): void {
        this.dispatchEvent(new Event('error'));
    }
}

function setup(timeoutMs = 1_000) {
    const xhrs: FakeXhr[] = [];
    const fetchFake = vi.fn<typeof fetch>(() =>
        Promise.resolve(
            new Response(JSON.stringify(fileMetadata), {
                status: 201,
                headers: { 'content-type': 'application/json' },
            }),
        ),
    );
    const client = createFetchEngineApiClient({
        baseUrl: BASE_URL,
        fetch: fetchFake,
        timeoutMs,
        createXhr: () => {
            const xhr = new FakeXhr();
            xhrs.push(xhr);
            return xhr as unknown as XMLHttpRequest;
        },
    });
    return { client, xhrs, fetchFake };
}

const file = new Blob(['hello'], { type: 'text/plain' });
const body = { file, name: 'notes.txt', purpose: 'knowledge' } as const;

/** Lets the client encode the body and open the request. */
async function opened(xhrs: readonly FakeXhr[]): Promise<FakeXhr> {
    await vi.waitFor(() => {
        if (xhrs[0]?.body === null || xhrs[0] === undefined) throw new Error('not sent yet');
    });
    const xhr = xhrs[0];
    if (!xhr) throw new Error('no request');
    return xhr;
}

describe('fetch client uploads with progress', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('sends the multipart body through XHR and reports progress up to the whole body', async () => {
        const { client, xhrs, fetchFake } = setup();
        const progress: UploadProgress[] = [];
        const pending = client.files.upload(body, AbortSignal.timeout(5_000), { onProgress: (p) => progress.push(p) });
        const xhr = await opened(xhrs);
        expect(xhr.method).toBe('POST');
        expect(xhr.url).toBe(UPLOAD_URL);
        expect(xhr.responseType).toBe('blob');
        expect(xhr.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
        const form = await new Response(xhr.body, {
            headers: { 'content-type': xhr.headers.get('content-type') ?? '' },
        }).formData();
        expect(await (form.get('file') as Blob).text()).toBe('hello');
        expect(form.get('name')).toBe('notes.txt');
        expect(form.get('purpose')).toBe('knowledge');
        const total = xhr.body?.size ?? 0;
        xhr.progress(10);
        xhr.progress(5);
        xhr.progress(total + 50);
        xhr.answer({ status: 201, body: JSON.stringify(fileMetadata) });
        expect(await pending).toEqual({ kind: 'ok', data: fileMetadata });
        expect(progress).toEqual([
            { loadedBytes: 10, totalBytes: total },
            { loadedBytes: total, totalBytes: total },
        ]);
        expect(fetchFake).not.toHaveBeenCalled();
    });

    it('completes the progress when the engine accepts before the last progress event', async () => {
        const { client, xhrs } = setup();
        const progress: UploadProgress[] = [];
        const pending = client.files.upload(body, AbortSignal.timeout(5_000), { onProgress: (p) => progress.push(p) });
        const xhr = await opened(xhrs);
        xhr.answer({ status: 201, body: JSON.stringify(fileMetadata) });
        await pending;
        const total = xhr.body?.size ?? 0;
        expect(progress).toEqual([{ loadedBytes: total, totalBytes: total }]);
    });

    it('reads a problem answer as a problem and reports no completion', async () => {
        const { client, xhrs } = setup();
        const progress: UploadProgress[] = [];
        const pending = client.files.upload(body, AbortSignal.timeout(5_000), { onProgress: (p) => progress.push(p) });
        const xhr = await opened(xhrs);
        xhr.answer({
            status: 415,
            body: JSON.stringify(createProblem('unsupported-media-type')),
            contentType: 'application/problem+json',
        });
        expect(await pending).toMatchObject({ kind: 'problem', problem: { code: 'unsupported-media-type' } });
        expect(progress).toEqual([]);
    });

    it('refuses an answer that came from a redirect, like fetch with redirect: error', async () => {
        const { client, xhrs } = setup();
        const pending = client.files.upload(body, AbortSignal.timeout(5_000), { onProgress: () => undefined });
        const xhr = await opened(xhrs);
        xhr.answer({ status: 201, body: JSON.stringify(fileMetadata), responseURL: `${BASE_URL}/auth/sign-in` });
        await expect(pending).rejects.toThrow(TypeError);
    });

    it('rejects on a network error', async () => {
        const { client, xhrs } = setup();
        const pending = client.files.upload(body, AbortSignal.timeout(5_000), { onProgress: () => undefined });
        (await opened(xhrs)).fail();
        await expect(pending).rejects.toThrow(TypeError);
    });

    it('aborts the request with the caller’s reason', async () => {
        const { client, xhrs } = setup();
        const controller = new AbortController();
        const pending = client.files.upload(body, controller.signal, { onProgress: () => undefined });
        const xhr = await opened(xhrs);
        controller.abort();
        const error = await pending.catch((e: unknown) => e);
        expect(xhr.aborted).toBe(true);
        expect(error).toMatchObject({ name: 'AbortError' });
    });

    it('never opens a request for a signal that is already aborted', async () => {
        const { client, xhrs } = setup();
        await expect(
            client.files.upload(body, AbortSignal.abort(), { onProgress: () => undefined }),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(xhrs).toEqual([]);
    });

    it('times out only after the upload stalls: each progress event restarts the deadline', async () => {
        const { client, xhrs } = setup(100);
        const pending = client.files
            .upload(body, new AbortController().signal, { onProgress: () => undefined })
            .catch((e: unknown) => e);
        const xhr = await opened(xhrs);
        vi.useFakeTimers();
        for (let loaded = 1; loaded <= 4; loaded++) {
            await vi.advanceTimersByTimeAsync(80);
            xhr.progress(loaded);
        }
        expect(xhr.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(100);
        expect(xhr.aborted).toBe(true);
        expect(await pending).toMatchObject({ name: 'TimeoutError' });
    });

    it('without an XHR factory, sends the encoded body through fetch and reports only the end', async () => {
        const { client, fetchFake } = (() => {
            const fetchFake = vi.fn<typeof fetch>(() =>
                Promise.resolve(
                    new Response(JSON.stringify(fileMetadata), {
                        status: 201,
                        headers: { 'content-type': 'application/json' },
                    }),
                ),
            );
            return {
                client: createFetchEngineApiClient({ baseUrl: BASE_URL, fetch: fetchFake, timeoutMs: 1_000 }),
                fetchFake,
            };
        })();
        const progress: UploadProgress[] = [];
        expect(
            await client.files.upload(body, AbortSignal.timeout(5_000), { onProgress: (p) => progress.push(p) }),
        ).toEqual({ kind: 'ok', data: fileMetadata });
        const init = fetchFake.mock.calls[0]?.[1];
        const sent = init?.body as Blob;
        expect(sent).toBeInstanceOf(Blob);
        expect(new Headers(init?.headers).get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
        expect(progress).toEqual([{ loadedBytes: sent.size, totalBytes: sent.size }]);
    });
});

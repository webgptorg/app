import { PUBLIC_FACE_MAX_BODY_BYTES, type PublicFaceFetcher } from '../../domain/abuse/public-face';

/** The body's first bytes as text; the rest is never read. */
async function readPrefix(response: Response, maxBytes: number): Promise<string> {
    const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
    if (reader === undefined) return '';
    const decoder = new TextDecoder();
    let text = '';
    let total = 0;
    while (total < maxBytes) {
        const next = await reader.read();
        if (next.done) return text + decoder.decode();
        const chunk = next.value.subarray(0, maxBytes - total);
        total += chunk.byteLength;
        text += decoder.decode(chunk, { stream: true });
    }
    await reader.cancel();
    return text + decoder.decode();
}

/**
 * Plain `fetch` as an anonymous visitor: no cookies (Workers keep no cookie jar, and none is sent), no credentials,
 * redirects returned rather than followed, and a user agent that says who is asking and where to complain.
 */
export function createFetchPublicFaceFetcher(deps: {
    readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
    readonly userAgent: string;
}): PublicFaceFetcher {
    return {
        async get(url, signal) {
            const response = await deps.fetch(url, {
                method: 'GET',
                headers: { Accept: 'text/html', 'User-Agent': deps.userAgent },
                redirect: 'manual',
                signal,
            });
            return {
                status: response.status,
                location: response.headers.get('Location'),
                contentType: response.headers.get('Content-Type'),
                body: await readPrefix(response, PUBLIC_FACE_MAX_BODY_BYTES),
            };
        },
    };
}

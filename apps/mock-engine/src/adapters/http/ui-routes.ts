import { z } from 'zod';

import type { BundleStore } from '../../domain/ui/bundle-store';
import { entryOf, isReserved, resolveStatic } from '../../domain/ui/static-route';

import type { HttpRoute } from './route';
import { defineHttpRoute } from './route';
import { problemResponse } from './route-handler';

const MAX_QUERY_PARAMETERS = 32;
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** The SPA keeps its state in the URL; the engine never reads the query of a UI request, it only bounds it. */
const UiQuery = z
    .object({})
    .catchall(z.string().max(8192))
    .refine((query) => Object.keys(query).length <= MAX_QUERY_PARAMETERS, 'too many query parameters');
const UiHeaders = z.strictObject({ accept: z.string().max(4096).optional() });

/** Open engine code, never from a bundle: what a signed-in visitor sees before the first bundle installed. */
function noBundlePage(): Response {
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Promptbook engine</title>
</head>
<body>
<h1>Promptbook engine</h1>
<p>The app is not installed yet: no signed UI release has been verified. The engine keeps checking.</p>
</body>
</html>
`;
    return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

/**
 * The active UI bundle behind the gateway session (anonymous visitors get only the sign-in page, which is open code).
 * Only files the verified manifest lists are served, with the manifest's entry as the SPA fallback; the security
 * headers are added by the HTTP app like everywhere else and never come from the bundle.
 */
export function createUiRoutes(deps: { readonly store: Pick<BundleStore, 'active' | 'read'> }): readonly HttpRoute[] {
    const serve = async (request: Request, accept: string | undefined): Promise<Response> => {
        const path = new URL(request.url).pathname;
        const bundle = deps.store.active();
        if (bundle === undefined) return isReserved(path) ? problemResponse({ code: 'not-found' }) : noBundlePage();
        const requested = resolveStatic(path, request.method, accept, bundle.manifest);
        const resolved = requested.kind === 'spa-fallback' ? entryOf(bundle.manifest) : requested;
        if (resolved.kind !== 'asset') return problemResponse({ code: 'not-found' });
        const bytes = await deps.store.read(bundle, resolved.file.path);
        if (bytes === undefined) return problemResponse({ code: 'not-found' });
        return new Response(new Uint8Array(bytes), {
            headers: {
                'Content-Type': resolved.contentType,
                'Content-Length': String(bytes.byteLength),
                'Cache-Control': resolved.cache === 'immutable' ? IMMUTABLE : 'no-cache',
            },
        });
    };
    const route = (path: '/' | '/{path+}') =>
        defineHttpRoute({
            transport: 'http',
            method: 'GET',
            path,
            auth: 'session',
            // The same bundle for every member: what they may do is the engine API's to decide.
            permission: null,
            rateLimit: 'ui-ip',
            params: path === '/' ? null : z.strictObject({ path: z.string().max(4096) }),
            query: UiQuery,
            headers: UiHeaders,
            body: null,
            handle: ({ request, headers }) => serve(request, headers.accept),
        });
    return [route('/'), route('/{path+}')];
}

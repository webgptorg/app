import { ENGINE_API_ROUTES, SIGN_IN_PATH } from '@ptbk/engine-api';

import type { CheckContext, ConformanceCheck } from '../../check';
import { Findings, skip } from '../../check';
import { SUITE, cleanUpUnexpected, walkPages } from './support';
import { createWorld } from './world';

const R = ENGINE_API_ROUTES;
const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const DEEP_LINK = '/conformance/sign-in-next?tab=chat&q=a%26b';
/** Protocol-relative: as `next`, the browser would leave the engine for this host after sign-in. */
const OFF_ORIGIN = '//conformance.invalid/sign-in-next';

/** An anonymous top-level navigation, as a browser sends it; the answer's sign-in `next`, or why there is none. */
async function signInNext(
    ctx: CheckContext,
    target: string,
): Promise<{ readonly next: string | null } | { readonly problem: string }> {
    // Concatenated, not resolved: `new URL('//host/…', base)` would name another origin instead of this path.
    const response = await ctx.target.fetch(`${ctx.target.baseUrl.origin}${target}`, {
        headers: {
            Accept: 'text/html',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
        },
        redirect: 'manual',
        signal: ctx.signal,
    });
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!REDIRECTS.has(response.status) || location === null) {
        return { problem: `answered ${String(response.status)}, not a redirect to ${SIGN_IN_PATH}` };
    }
    const url = new URL(location, ctx.target.baseUrl);
    if (url.origin !== ctx.target.baseUrl.origin || url.pathname !== SIGN_IN_PATH) {
        return { problem: `redirected elsewhere than ${SIGN_IN_PATH}` };
    }
    return { next: url.searchParams.get('next') };
}

export const GATEWAY_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.gateway.cross-site-refused',
        suite: SUITE,
        title: 'A state-changing request with Sec-Fetch-Site: cross-site is refused with 403, even with a valid session',
        async run(ctx) {
            if (ctx.target.gateway === false) skip('the target runs the API without the engine gateway');
            const world = await createWorld(ctx);
            const findings = new Findings();
            const name = world.name('cross-site');
            const result = await world.owner.call(R.createFolder, {
                body: { name },
                headers: { Origin: 'https://cross-site.conformance.invalid', 'Sec-Fetch-Site': 'cross-site' },
            });
            if (result.kind === 'ok') {
                cleanUpUnexpected(ctx, world.owner, R.createFolder, result);
                findings.add(`POST /folders: a cross-site request got ${String(result.status)}`);
            } else if (result.status !== 403) {
                findings.add(`POST /folders: a cross-site request got ${String(result.status)}, not 403`);
            }
            const { pages } = await walkPages(world.owner, R.listFolders, { limit: 100 });
            if (pages.flat().some((folder) => folder.name === name)) {
                findings.add('POST /folders: the refused cross-site request created the folder');
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.gateway.sign-in-keeps-next',
        suite: SUITE,
        title: 'An anonymous page request is redirected to sign-in with its path and query as next, never an off-origin one',
        async run(ctx) {
            if (ctx.target.gateway === false) skip('the target runs the API without the engine gateway');
            const findings = new Findings();
            const deep = await signInNext(ctx, DEEP_LINK);
            if ('problem' in deep) findings.add(`GET ${DEEP_LINK}: ${deep.problem}`);
            else if (deep.next !== DEEP_LINK) {
                findings.add(`GET ${DEEP_LINK}: next is ${deep.next === null ? 'missing' : 'another path'}`);
            }
            const offOrigin = await signInNext(ctx, OFF_ORIGIN);
            if ('problem' in offOrigin) findings.add(`GET ${OFF_ORIGIN}: ${offOrigin.problem}`);
            else if (offOrigin.next !== null) findings.add(`GET ${OFF_ORIGIN}: carried a next, which must be absent`);
            return findings.outcome();
        },
    },
];

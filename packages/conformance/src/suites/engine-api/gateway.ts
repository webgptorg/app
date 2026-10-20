import { ENGINE_API_ROUTES } from '@ptbk/engine-api';

import type { ConformanceCheck } from '../../check';
import { Findings, skip } from '../../check';
import { SUITE, cleanUpUnexpected, walkPages } from './support';
import { createWorld } from './world';

const R = ENGINE_API_ROUTES;

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
];

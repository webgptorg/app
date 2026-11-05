import {
    ENGINE_API_ROUTE_LIST,
    RESERVED_CAPABILITIES,
    capabilityLabel,
    isReservedCapability,
    supports,
} from '@ptbk/engine-api';

import type { ConformanceCheck } from '../../check';
import { Findings, skip } from '../../check';
import { requireCapability } from './capability-support';
import { placeholderRequest } from './requests';
import { SUITE, attempt } from './support';
import { createWorld } from './world';

const DESIGN = 'docs/engine-integration/live-sessions.md';

/**
 * Live audio, video and the browser tab are designed but not specified (ADR 0019). Until they are, an engine must not
 * advertise them and their routes stay inert; the checks of each capability are registered so engine teams can track
 * them, and skip like any capability the engine does not advertise.
 */
export const LIVE_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.live.reserved',
        suite: SUITE,
        title: 'The engine advertises no reserved live capability, and their routes answer 404 capability-not-supported',
        async run(ctx) {
            const world = await createWorld(ctx);
            const engine = await world.engine();
            const findings = new Findings();
            for (const capability of Object.values(RESERVED_CAPABILITIES)) {
                if (supports(engine, capability)) {
                    findings.add(
                        `GET /engine advertises ${capabilityLabel(capability)}, which is design only (${DESIGN})`,
                    );
                }
            }
            for (const route of ENGINE_API_ROUTE_LIST) {
                if (route.capability === undefined || !isReservedCapability(route.capability)) continue;
                await attempt(findings, async () => {
                    await world.owner.problem(
                        route,
                        await placeholderRequest(route, world),
                        'capability-not-supported',
                    );
                });
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.live-audio.session',
        suite: SUITE,
        title: 'A voice session opens in a chat and its channel carries audio both ways (live-audio@1, not written yet)',
        async run(ctx) {
            await requireCapability(await createWorld(ctx), RESERVED_CAPABILITIES.liveAudio);
            skip('not-implemented');
        },
    },
    {
        id: 'engine-api.browser-tab.session',
        suite: SUITE,
        title: 'A browser tab session is owner-only, behind step-up and limited to one allowed origin (browser-tab@1, not written yet)',
        async run(ctx) {
            await requireCapability(await createWorld(ctx), RESERVED_CAPABILITIES.browserTab);
            skip('not-implemented');
        },
    },
];

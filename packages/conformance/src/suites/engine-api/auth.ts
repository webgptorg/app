import { ENGINE_API_ROUTE_LIST } from '@ptbk/engine-api';

import type { ConformanceCheck } from '../../check';
import { CheckSkip, Findings } from '../../check';
import { EngineApi, describe } from './api';
import { placeholderRequest, validRequest } from './requests';
import { SUITE, attempt, cleanUpUnexpected } from './support';
import type { World } from './world';
import { createWorld } from './world';

const decoder = new TextDecoder();

export const AUTH_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.auth.unauthenticated-401',
        suite: SUITE,
        title: 'Every route without credentials answers 401 problem+json and leaks no resource data',
        async run(ctx) {
            // Real IDs when the target gives an owner, so a response that leaks the named resource shows up.
            let world: World | null = null;
            try {
                world = await createWorld(ctx);
            } catch (error) {
                if (!(error instanceof CheckSkip)) throw error;
            }
            const anonymous = new EngineApi(ctx, null);
            const findings = new Findings();
            const refusals: { readonly route: string; readonly body: string }[] = [];
            for (const route of ENGINE_API_ROUTE_LIST) {
                await attempt(findings, async () => {
                    const real = world === null ? null : await validRequest(route, world);
                    const request = real ?? (await placeholderRequest(route, world));
                    const result = await anonymous.call(route, request);
                    if (result.kind === 'ok') {
                        if (world !== null) cleanUpUnexpected(ctx, world.owner, route, result);
                        findings.add(`${describe(route)}: answered ${String(result.status)} without credentials`);
                        return;
                    }
                    if (result.problem.code !== 'unauthenticated') {
                        findings.add(`${describe(route)}: answered ${result.problem.code} instead of unauthenticated`);
                    }
                    refusals.push({ route: describe(route), body: decoder.decode(result.raw.bytes) });
                });
            }
            // The problem's strict schema leaves only free text (title, detail, instance) to leak through; resource
            // names are data the caller cannot know without signing in, unlike the IDs it put in the URL.
            if (world !== null) {
                const names = [(await world.agent()).name, (await world.folder()).name, (await world.secret()).name];
                for (const refusal of refusals) {
                    if (names.some((name) => refusal.body.includes(name))) {
                        findings.add(`${refusal.route}: the 401 carries a resource name`);
                    }
                }
            }
            return findings.outcome();
        },
    },
];

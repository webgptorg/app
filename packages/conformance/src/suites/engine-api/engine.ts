import { ENGINE_API_ROUTE_LIST, ENGINE_API_ROUTES, isReservedCapability, supportsRoute } from '@ptbk/engine-api';
import { AnyHeartbeat, Ed25519PublicKey, deriveEngineId, ed25519PublicKeyToBytes } from '@ptbk/protocol';

import type { ConformanceCheck } from '../../check';
import { Findings, fail, skip } from '../../check';
import { describe, issuesOf } from './api';
import { placeholderRequest } from './requests';
import { SUITE, attempt } from './support';
import { createWorld } from './world';

const R = ENGINE_API_ROUTES;
const decoder = new TextDecoder();

export const ENGINE_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.engine.info',
        suite: SUITE,
        title: 'GET /engine from an API 1.1 engine sends engineId and capabilities and nothing undeclared',
        async run(ctx) {
            const world = await createWorld(ctx);
            const result = await world.owner.call(R.getEngine);
            if (result.kind === 'problem') fail(`GET /engine: ${String(result.status)} ${result.problem.code}`);
            const findings = new Findings();
            // The schema defaults both fields for API 1.0 engines, so their presence is checked on the wire.
            const raw = JSON.parse(decoder.decode(result.raw.bytes)) as Readonly<Record<string, unknown>>;
            if (typeof raw['engineId'] !== 'string') findings.add('GET /engine: engineId is missing or null');
            if (!Array.isArray(raw['capabilities'])) findings.add('GET /engine: capabilities is missing');
            if (result.data.hostname !== ctx.target.baseUrl.hostname) {
                findings.add('GET /engine: hostname is not the hostname the API was reached on');
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.engine.id-matches-key',
        suite: SUITE,
        title: "GET /engine's engineId is the one derived from the engine's public key",
        async run(ctx) {
            if (ctx.target.enginePublicKey === undefined) skip('the target does not name the engine public key');
            const key = Ed25519PublicKey.safeParse(ctx.target.enginePublicKey);
            if (!key.success) skip('the target names a public key that is not base64url Ed25519');
            const expected = await deriveEngineId(ed25519PublicKeyToBytes(key.data));
            const world = await createWorld(ctx);
            const { engineId } = await world.owner.ok(R.getEngine);
            const findings = new Findings();
            if (engineId !== expected) findings.add("GET /engine: engineId is not derived from the engine's key");
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.capabilities.unadvertised-404',
        suite: SUITE,
        title: 'Every route of a capability the engine does not advertise answers 404 capability-not-supported',
        async run(ctx) {
            const world = await createWorld(ctx);
            const engine = await world.engine();
            const missing = ENGINE_API_ROUTE_LIST.filter(
                (route) => route.capability && !isReservedCapability(route.capability) && !supportsRoute(engine, route),
            );
            if (missing.length === 0) skip('the engine advertises every optional route this contract defines');
            const findings = new Findings();
            for (const route of missing) {
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
        id: 'engine-api.security.heartbeat-body',
        suite: SUITE,
        title: "The security panel's lastHeartbeat.body is a heartbeat as the protocol defines it",
        async run(ctx) {
            const world = await createWorld(ctx);
            const { lastHeartbeat } = await world.owner.ok(R.getSecurityOverview);
            if (lastHeartbeat === null) skip('the engine has sent no heartbeat yet');
            let body: unknown;
            try {
                body = JSON.parse(lastHeartbeat.body);
            } catch {
                fail(`${describe(R.getSecurityOverview)}: lastHeartbeat.body is not JSON`);
            }
            const parsed = AnyHeartbeat.safeParse(body);
            const findings = new Findings();
            if (!parsed.success)
                findings.add(`lastHeartbeat.body is not a Heartbeat: ${issuesOf(parsed.error.issues)}`);
            else {
                const { engineId } = await world.engine();
                if (parsed.data.engineId !== engineId) findings.add("lastHeartbeat.body names another engine's ID");
            }
            return findings.outcome();
        },
    },
];

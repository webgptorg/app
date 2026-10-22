import { ENGINE_API_ROUTES, KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { RouteDefinition } from '@ptbk/engine-api';

import type { ConformanceCheck } from '../../check';
import { Findings } from '../../check';
import { randomToken } from '../../random';
import { describe } from './api';
import { checkFilter, checkStableWalk, requireCapability } from './capability-support';
import { EVENT_WINDOW_MS } from './schemas';
import { canaryForms } from './secrets';
import { SUITE, attempt } from './support';
import type { World } from './world';
import { createWorld } from './world';

const R = ENGINE_API_ROUTES;
const CREATED = 5;
const CANARY_LENGTH = 32;
const decoder = new TextDecoder();

async function createMcpServer(
    world: World,
    label: string,
    secretNames: readonly string[] = [],
    scope: 'agent' | 'engine' = 'agent',
) {
    const agentId = scope === 'engine' ? null : (await world.agent()).id;
    const integration = await world.owner.ok(R.createIntegration, {
        body: {
            kind: 'mcp-server',
            agentId,
            name: world.name(label),
            url: 'https://mcp.conformance.invalid/sse',
            ...(secretNames.length === 0 ? {} : { secretNames: [...secretNames] }),
        },
    });
    world.ctx.resources.defer((signal) =>
        world.owner.withSignal(signal).send(R.deleteIntegration, { params: { integrationId: integration.id } }),
    );
    return integration;
}

export const INTEGRATION_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.integrations.paging',
        suite: SUITE,
        title: 'GET /integrations pages without gaps or duplicates, its filters list only matching integrations, and an agent sees the engine-wide ones',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.integrations);
            const findings = new Findings();
            const created: string[] = [];
            for (let index = 0; index < CREATED; index++) created.push((await createMcpServer(world, 'page')).id);
            const { id: agentId } = await world.agent();
            await attempt(findings, () => checkStableWalk(world, findings, R.listIntegrations, { agentId }));
            await attempt(findings, async () => {
                const listed = await world.owner.ok(R.listIntegrations, { query: { agentId, limit: 100 } });
                const missing = created.filter((id) => !listed.items.some((integration) => integration.id === id));
                if (missing.length > 0) {
                    findings.add(`GET /integrations: ${String(missing.length)} created integrations are missing`);
                }
                checkFilter(findings, R.listIntegrations, 'agentId', listed.items, (item) => item.agentId === agentId);
                const servers = await world.owner.ok(R.listIntegrations, { query: { kind: 'mcp-server', limit: 50 } });
                checkFilter(findings, R.listIntegrations, 'kind', servers.items, ({ kind }) => kind === 'mcp-server');
                const connected = await world.owner.ok(R.listIntegrations, {
                    query: { status: 'connected', limit: 50 },
                });
                checkFilter(
                    findings,
                    R.listIntegrations,
                    'status',
                    connected.items,
                    ({ status }) => status === 'connected',
                );
                const attention = await world.owner.ok(R.listIntegrations, {
                    query: { status: 'needs-attention,error', limit: 50 },
                });
                checkFilter(
                    findings,
                    R.listIntegrations,
                    'status set',
                    attention.items,
                    ({ status }) => status === 'needs-attention' || status === 'error',
                );
            });
            await attempt(findings, async () => {
                const engineWide = await createMcpServer(world, 'engine-wide', [], 'engine');
                const own = await world.owner.ok(R.listIntegrations, { query: { agentId, limit: 100 } });
                if (own.items.some(({ id }) => id === engineWide.id)) {
                    findings.add(
                        'GET /integrations: agentId without includeEngineWide lists an engine-wide integration',
                    );
                }
                const usable = await world.owner.ok(R.listIntegrations, {
                    query: { agentId, includeEngineWide: 'true', limit: 100 },
                });
                const ids = new Set<string>(usable.items.map(({ id }) => id));
                if (!ids.has(engineWide.id) || created.some((id) => !ids.has(id))) {
                    findings.add(
                        "GET /integrations: includeEngineWide misses the agent's or the engine-wide integrations",
                    );
                }
                checkFilter(
                    findings,
                    R.listIntegrations,
                    'includeEngineWide',
                    usable.items,
                    (item) => item.agentId === agentId || item.agentId === null,
                );
            });
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.integrations.secrets-never-returned',
        suite: SUITE,
        title: 'A secret an integration references never comes back in integration, activity or event bytes',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.integrations);
            const seen: { readonly route: RouteDefinition; readonly bytes: Uint8Array }[] = [];
            world.owner.observe((route, bytes) => seen.push({ route, bytes }));
            const findings = new Findings();
            const canary = randomToken(ctx.random, CANARY_LENGTH);
            const events = world.owner.stream(R.streamEvents, {}, { maxMs: EVENT_WINDOW_MS * 3 });
            const secret = await world.createSecret('integration-canary', canary);
            const integration = await createMcpServer(world, 'canary', [secret.name]);
            const params = { integrationId: integration.id };
            const ref = integration.secretRefs.find(({ name }) => name === secret.name);
            if (ref?.secretId !== secret.id || ref.state !== 'resolved') {
                findings.add('POST /integrations: the secret is not referenced by name and ID as resolved');
            }
            await attempt(findings, async () => {
                await world.owner.ok(R.getIntegration, { params });
                await world.owner.ok(R.updateIntegration, { params, body: { secretNames: [secret.name] } });
                await world.owner.ok(R.checkIntegration, { params });
                await world.owner.ok(R.disableIntegration, { params });
                await world.owner.ok(R.enableIntegration, { params });
                await world.owner.ok(R.listIntegrations, { query: { limit: 100 } });
                await world.owner.ok(R.listActivity, { query: { integrationId: integration.id, limit: 100 } });
                await world.owner.ok(R.listActivity, { query: { limit: 100 } });
            });
            await attempt(findings, async () => {
                await events;
            });
            const forms = canaryForms(canary);
            for (const { route, bytes } of seen) {
                const text = decoder.decode(bytes);
                const found = forms.find(({ text: form }) => text.includes(form));
                if (found) findings.add(`${describe(route)}: the referenced secret's value came back (${found.form})`);
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.integrations.stats',
        suite: SUITE,
        title: "GET /integrations/stats counts an agent's integrations by status and the engine's cover the agent's",
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.integrations);
            const findings = new Findings();
            const { id: agentId } = await world.agent();
            const total = (stats: Readonly<Record<string, number>>) =>
                Object.values(stats).reduce((sum, count) => sum + count, 0);
            const before = await world.owner.ok(R.getIntegrationStats, { query: { agentId } });
            const integration = await createMcpServer(world, 'stats');
            await world.owner.ok(R.disableIntegration, { params: { integrationId: integration.id } });
            const disabled = await world.owner.ok(R.getIntegrationStats, { query: { agentId } });
            if (total(disabled) !== total(before) + 1 || disabled.disconnected !== before.disconnected + 1) {
                findings.add('GET /integrations/stats: a new, disabled integration is not counted as disconnected');
            }
            const all = await world.owner.ok(R.getIntegrationStats, {});
            const keys = ['connected', 'needsAttention', 'disconnected', 'error'] as const;
            if (keys.some((key) => all[key] < disabled[key])) {
                findings.add("GET /integrations/stats: an engine-wide count is lower than one agent's");
            }
            return findings.outcome();
        },
    },
];

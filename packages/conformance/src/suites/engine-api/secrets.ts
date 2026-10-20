import { ENGINE_API_ROUTE_LIST, ENGINE_API_ROUTES } from '@ptbk/engine-api';
import type { RouteDefinition, SecretMetadata } from '@ptbk/engine-api';
import { encodeBase64Std, encodeBase64Url, utf8Encode } from '@ptbk/protocol';

import type { ConformanceCheck } from '../../check';
import { Findings, fail } from '../../check';
import { randomToken } from '../../random';
import type { EngineApi } from './api';
import { describe } from './api';
import { EVENT_WINDOW_MS, readRoute } from './schemas';
import { SUITE, attempt } from './support';
import { createWorld } from './world';

const R = ENGINE_API_ROUTES;
const CANARY_LENGTH = 32;

/**
 * Every way a value commonly reappears: as is, as hex, and as standard or URL-safe base64 at each of the three byte
 * alignments it can have inside a longer encoded blob (only the characters no neighbouring byte can change).
 */
export function canaryForms(canary: string): readonly { readonly form: string; readonly text: string }[] {
    const bytes = utf8Encode(canary);
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const forms = [
        { form: 'raw', text: canary },
        { form: 'hex', text: hex },
        { form: 'hex', text: hex.toUpperCase() },
    ];
    for (let offset = 0; offset < 3; offset++) {
        const shifted = new Uint8Array(offset + bytes.length);
        shifted.set(bytes, offset);
        for (const [form, encoded] of [
            ['base64', encodeBase64Std(shifted)],
            ['base64url', encodeBase64Url(shifted)],
        ] as const) {
            forms.push({ form, text: encoded.slice(4, encoded.replace(/=+$/, '').length - 4) });
        }
    }
    return forms;
}

const decoder = new TextDecoder();

function secretByName(api: EngineApi, name: string): Promise<SecretMetadata | undefined> {
    return api
        .ok(R.listSecrets, { query: { q: name, limit: 100 } })
        .then(({ items }) => items.find((s) => s.name === name));
}

export const SECRET_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.secrets.never-returned',
        suite: SUITE,
        title: 'A secret value never comes back: not from any GET route, not on the event stream, in no encoding',
        async run(ctx) {
            const world = await createWorld(ctx);
            const seen: { readonly route: RouteDefinition; readonly bytes: Uint8Array }[] = [];
            world.owner.observe((route, bytes) => seen.push({ route, bytes }));
            const findings = new Findings();
            const canaries = [randomToken(ctx.random, CANARY_LENGTH), randomToken(ctx.random, CANARY_LENGTH)];

            const events = world.owner.stream(R.streamEvents, {}, { maxMs: EVENT_WINDOW_MS * 3 });
            const secret = await world.createSecret('canary', canaries[0] ?? '');
            await world.owner.ok(R.replaceSecretValue, {
                params: { secretId: secret.id },
                body: { value: canaries[1] ?? '' },
            });
            const { id: agentId } = await world.agent();
            await world.owner
                .ok(R.createSecret, {
                    body: {
                        name: world.name('agent-canary'),
                        scope: { kind: 'agent', agentId },
                        value: canaries[0] ?? '',
                    },
                })
                .then((created) => {
                    ctx.resources.defer((signal) =>
                        world.owner.withSignal(signal).send(R.deleteSecret, { params: { secretId: created.id } }),
                    );
                });
            for (const route of ENGINE_API_ROUTE_LIST) {
                if (route.method !== 'GET' || !(await world.advertises(route))) continue;
                await attempt(findings, () => readRoute(world, world.owner, route, findings));
            }
            await attempt(findings, async () => {
                await world.owner.ok(R.listSecrets, { query: { q: secret.name, status: 'active' } });
                await world.owner.ok(R.listSecrets, { query: { scope: 'agent', agentId } });
            });
            await attempt(findings, async () => {
                await events;
            });

            const forms = canaries.flatMap((canary) => canaryForms(canary));
            for (const { route, bytes } of seen) {
                const text = decoder.decode(bytes);
                const found = forms.find(({ text: form }) => text.includes(form));
                if (found) findings.add(`${describe(route)}: a secret value came back (${found.form})`);
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.secrets.lifecycle',
        suite: SUITE,
        title: 'Replacing, revoking and deleting a secret change its metadata as the contract says',
        async run(ctx) {
            const world = await createWorld(ctx);
            const { owner } = world;
            const findings = new Findings();
            const created = await world.createSecret('lifecycle', randomToken(ctx.random, CANARY_LENGTH));
            const params = { secretId: created.id };
            if (created.status !== 'active') findings.add(`POST /secrets: a new secret is ${created.status}`);
            if (created.scope.kind !== 'engine') findings.add('POST /secrets: the scope changed');

            const replaced = await owner.ok(R.replaceSecretValue, {
                params,
                body: { value: randomToken(ctx.random, CANARY_LENGTH) },
            });
            if (replaced.id !== created.id || replaced.name !== created.name) {
                findings.add('PUT /secrets/{secretId}/value: the secret changed identity');
            }
            if (replaced.status !== 'active')
                findings.add(`PUT /secrets/{secretId}/value: status is ${replaced.status}`);
            if (replaced.createdAt !== created.createdAt)
                findings.add('PUT /secrets/{secretId}/value: createdAt changed');
            if (Date.parse(replaced.updatedAt) < Date.parse(created.updatedAt)) {
                findings.add('PUT /secrets/{secretId}/value: updatedAt went backwards');
            }

            const revoked = await owner.ok(R.revokeSecret, { params });
            if (revoked.status !== 'revoked')
                findings.add(`POST /secrets/{secretId}/revoke: status is ${revoked.status}`);
            if ((await secretByName(owner, created.name))?.status !== 'revoked') {
                findings.add('GET /secrets: a revoked secret is not listed as revoked');
            }
            await attempt(findings, async () => {
                const again = await owner.ok(R.revokeSecret, { params });
                if (again.status !== 'revoked')
                    fail('POST /secrets/{secretId}/revoke: revoking twice is not idempotent');
            });
            await attempt(findings, async () => {
                await owner.problem(
                    R.replaceSecretValue,
                    { params, body: { value: randomToken(ctx.random, CANARY_LENGTH) } },
                    'secret-revoked',
                );
            });

            await owner.ok(R.deleteSecret, { params });
            if ((await secretByName(owner, created.name)) !== undefined) {
                findings.add('GET /secrets: a deleted secret is still listed');
            }
            await attempt(findings, async () => {
                await owner.problem(R.revokeSecret, { params }, 'not-found');
            });
            return findings.outcome();
        },
    },
];

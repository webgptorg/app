import { describe, expect, it } from 'vitest';

import { testOrgId } from '../../testing/billing-fixtures';
import { createTestEngine } from '../../testing/test-engine';
import { createTestRegistration } from '../../testing/test-registration';
import { linkCodeIdSchema } from '../ids';
import { LINK_CODE_TTL_MS } from './issue-link-code';
import { readLinkCodeStatus } from './read-link-code-status';

async function setup() {
    const t = createTestRegistration();
    const orgId = testOrgId();
    const outcome = await t.tryIssue(orgId);
    if (outcome.kind !== 'issued') {
        throw new Error('expected a code');
    }
    const status = (org = orgId, id = outcome.linkCodeId) =>
        readLinkCodeStatus({ linkCodes: t.stores.linkCodes, engines: t.stores.engines, clock: t.clock }, org, id);
    return { ...t, orgId, issued: outcome, status };
}

describe('readLinkCodeStatus', () => {
    it('follows a code from pending to linked, with the engine’s address', async () => {
        const t = await setup();
        expect(await t.status()).toEqual({ kind: 'pending', expiresAt: t.issued.expiresAt });
        const engine = await createTestEngine();
        const registered = await t.register(await engine.register(t.issued.linkCode));
        if (registered.kind !== 'registered') {
            throw new Error('expected a registration');
        }
        expect(await t.status()).toEqual({
            kind: 'linked',
            engineId: engine.engineId,
            hostname: registered.response.hostname,
        });
    });

    it('stays linked when the engine retries with the spent code after a lost answer', async () => {
        const t = await setup();
        const engine = await createTestEngine();
        const request = await engine.register(t.issued.linkCode);
        expect((await t.register(request)).kind).toBe('registered');
        expect((await t.register(request)).kind).toBe('invalid-link-code');
        t.clock.advance(LINK_CODE_TTL_MS);
        expect((await t.status()).kind).toBe('linked');
    });

    it('answers expired once an unused code is past its lifetime', async () => {
        const t = await setup();
        t.clock.advance(LINK_CODE_TTL_MS);
        expect(await t.status()).toEqual({ kind: 'expired' });
    });

    it('knows nothing about another organization’s code or an unknown ID', async () => {
        const t = await setup();
        expect(await t.status(testOrgId())).toEqual({ kind: 'not-found' });
        expect(await t.status(t.orgId, linkCodeIdSchema.parse('a'.repeat(26)))).toEqual({ kind: 'not-found' });
    });

    it('answers not-found when the linked engine is not the organization’s', async () => {
        const t = await setup();
        const engine = await createTestEngine();
        expect((await t.register(await engine.register(t.issued.linkCode))).kind).toBe('registered');
        const record = t.stores.state.engines.get(engine.engineId);
        if (record === undefined) {
            throw new Error('expected the engine');
        }
        t.stores.state.engines.set(engine.engineId, { ...record, orgId: testOrgId() });
        expect(await t.status()).toEqual({ kind: 'not-found' });
    });
});

import { describe, expect, it } from 'vitest';

import { KNOWN_CAPABILITIES } from '../capabilities/capability';
import type { EngineApiResponse } from '../client';
import { AgentId, InviteId, MemberId } from '../common';
import { createInMemoryEngine } from '../in-memory-client';
import { createDemoSeed } from './demo-seed';

const signal = () => AbortSignal.timeout(5_000);
const AGENT = AgentId.parse('agent-a');

function code(response: EngineApiResponse<unknown>): string {
    return response.kind === 'problem' ? response.problem.code : 'ok';
}

describe('an engine without the features Reborn does not have', () => {
    const { client } = createInMemoryEngine({
        capabilities: [KNOWN_CAPABILITIES.files],
        seed: { agents: [{ id: AGENT, source: 'Ada\nPERSONA Research' }] },
    });

    it('refuses their routes with capability-not-supported, before reading the input', async () => {
        const refused = [
            client.members.listInvites({}, signal()),
            client.members.createInvite({ role: 'member', expiresAt: '2030-01-01T00:00:00Z' }, signal()),
            client.members.revokeInvite(InviteId.parse('invite-x'), signal()),
            client.members.update(MemberId.parse('member-owner'), { role: 'viewer' }, signal()),
            client.members.remove(MemberId.parse('member-owner'), signal()),
            client.apiTokens.list({}, signal()),
            client.audit.list({}, signal()),
            client.audit.verify(signal()),
            client.agents.validate({ source: 'Ada' }, signal()),
            client.agents.listRevisions(AGENT, {}, signal()),
            client.agents.update(AGENT, { visibility: 'private' }, signal()),
            client.agents.restore(AGENT, signal()),
        ];
        for (const response of await Promise.all(refused)) expect(code(response)).toBe('capability-not-supported');
    });

    it('keeps the core reads: members, the current member and the Book source', async () => {
        expect(code(await client.members.list({}, signal()))).toBe('ok');
        expect(code(await client.me.get(signal()))).toBe('ok');
        expect(code(await client.agents.getSource(AGENT, signal()))).toBe('ok');
    });
});

describe('activity of capabilities the engine does not advertise', () => {
    const kinds = async (capabilities?: readonly { id: string; version: number }[]) => {
        const { client } = createInMemoryEngine({
            seed: createDemoSeed(),
            ...(capabilities === undefined ? {} : { capabilities }),
        });
        const page = await client.activity.list({ limit: 100 }, signal());
        if (page.kind !== 'ok') throw new Error('activity refused');
        return page.data.items.map((item) => (item.kind === 'known' ? item.activity.kind.split('.')[0] : item.kind));
    };

    it('is not listed, while core activity is', async () => {
        const all = await kinds();
        expect(all).toEqual(expect.arrayContaining(['run', 'trigger']));
        const files = await kinds([KNOWN_CAPABILITIES.files]);
        expect(files.filter((area) => ['run', 'trigger', 'integration', 'member'].includes(area ?? ''))).toEqual([]);
        expect(files).toContain('engine');
    });
});

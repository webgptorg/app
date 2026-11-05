import { describe, expect, it } from 'vitest';

import { KNOWN_CAPABILITIES } from '../capabilities/capability';
import type { EngineApiResponse } from '../client';
import { AgentId, InviteId, MemberId } from '../common';
import { createInMemoryEngine } from '../in-memory-client';

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

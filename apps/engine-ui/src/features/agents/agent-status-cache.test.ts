import { AgentId, Timestamp } from '@ptbk/engine-api';
import type { AgentRunStatus } from '@ptbk/engine-api';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { writeAgentStatus } from './agent-status-cache';
import { agentKeys } from './agents-keys';

const id = AgentId.parse('agent-1');
const at = (minute: number): AgentRunStatus => ({
    state: minute % 2 === 0 ? 'running' : 'stopped',
    since: Timestamp.parse(new Date(Date.UTC(2026, 9, 1, 12, minute)).toISOString()),
});

describe('writeAgentStatus', () => {
    it('keeps the newer state when an older one arrives late', () => {
        const queryClient = new QueryClient();
        writeAgentStatus(queryClient, id, at(2));
        writeAgentStatus(queryClient, id, at(1));
        expect(queryClient.getQueryData(agentKeys.status(id))).toEqual(at(2));
        writeAgentStatus(queryClient, id, at(3));
        expect(queryClient.getQueryData(agentKeys.status(id))).toEqual(at(3));
    });
});

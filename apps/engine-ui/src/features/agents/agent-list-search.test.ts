import { describe, expect, it } from 'vitest';

import { agentListParams, AgentListSearch } from './agent-list-search';

describe('AgentListSearch', () => {
    it('keeps valid values and sends every one of them to the engine', () => {
        const search = AgentListSearch.parse({
            q: '  lead ',
            status: 'running',
            visibility: 'public',
            sort: 'name',
            cursor: 'abc_-1',
        });
        expect(agentListParams(search)).toEqual({
            origin: 'content',
            q: 'lead',
            status: 'running',
            visibility: 'public',
            sort: 'name',
            cursor: 'abc_-1',
        });
    });

    it('falls back to defaults for anything it cannot use', () => {
        const search = AgentListSearch.parse({
            q: '   ',
            status: 'sleeping',
            visibility: 42,
            sort: 'random',
            cursor: '../etc',
            extra: 'kept by the router, ignored here',
        });
        expect(agentListParams(search)).toEqual({ origin: 'content', sort: '-updatedAt' });
    });
});

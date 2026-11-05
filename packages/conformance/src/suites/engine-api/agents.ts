import { ENGINE_API_ROUTES, KNOWN_CAPABILITIES } from '@ptbk/engine-api';

import type { ConformanceCheck } from '../../check';
import { Findings } from '../../check';
import { BROKEN_BOOK, validBook } from '../../fixtures/books';
import type { EngineApi } from './api';
import { requireCapability } from './capability-support';
import { SUITE, attempt, walkPages } from './support';
import { createWorld } from './world';

const R = ENGINE_API_ROUTES;

async function listedIds(api: EngineApi, q: string, deleted: 'exclude' | 'include' | 'only'): Promise<Set<string>> {
    const { pages } = await walkPages(api, R.listAgents, { q, deleted, limit: 100 }, 10);
    return new Set(pages.flat().map(({ id }) => id));
}

export const AGENT_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.agents.create-and-list',
        suite: SUITE,
        title: 'An agent created from a book appears in the list and serves its source',
        async run(ctx) {
            const world = await createWorld(ctx);
            const findings = new Findings();
            const agent = await world.createAgent('created');
            if (agent.deletedAt !== null) findings.add('POST /agents: a new agent is already deleted');
            if (!(await listedIds(world.owner, agent.name, 'exclude')).has(agent.id)) {
                findings.add('GET /agents: the new agent is not listed when searching for its name');
            }
            const fetched = await world.owner.ok(R.getAgent, { params: { agentId: agent.id } });
            if (JSON.stringify(fetched) !== JSON.stringify(agent)) {
                findings.add('GET /agents/{agentId}: differs from what POST /agents returned');
            }
            const source = await world.owner.ok(R.getAgentSource, { params: { agentId: agent.id } });
            if (source.revisionId !== agent.currentRevisionId) {
                findings.add("GET /agents/{agentId}/source: revisionId is not the agent's currentRevisionId");
            }
            if (!source.source.includes(agent.name)) {
                findings.add('GET /agents/{agentId}/source: not the source the agent was created from');
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.agents.revision-conflict',
        suite: SUITE,
        title: 'A source update from a stale baseRevisionId is refused with 409 revision-conflict and changes nothing',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.bookEditor);
            const findings = new Findings();
            const agent = await world.createAgent('revisions');
            const params = { agentId: agent.id };
            const first = await world.owner.ok(R.getAgentSource, { params });
            const edited = `${first.source}\nNOTE Edited by the conformance suite.\n`;
            const second = await world.owner.ok(R.updateAgentSource, {
                params,
                body: { source: edited, baseRevisionId: first.revisionId },
            });
            if (second.revisionId === first.revisionId) {
                findings.add('PUT /agents/{agentId}/source: an edit kept the old revision ID');
            }
            await attempt(findings, async () => {
                await world.owner.problem(
                    R.updateAgentSource,
                    { params, body: { source: `${edited}\nNOTE A stale edit.\n`, baseRevisionId: first.revisionId } },
                    'revision-conflict',
                );
            });
            const after = await world.owner.ok(R.getAgentSource, { params });
            if (after.revisionId !== second.revisionId || after.source !== edited) {
                findings.add('PUT /agents/{agentId}/source: the refused edit changed the source');
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.agents.delete-restore',
        suite: SUITE,
        title: 'Deleting an agent hides it from the list; restoring brings it back',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.agentManagement);
            const findings = new Findings();
            const agent = await world.createAgent('deleted');
            const params = { agentId: agent.id };
            const deleted = await world.owner.ok(R.deleteAgent, { params });
            if (deleted.deletedAt === null) findings.add('DELETE /agents/{agentId}: deletedAt stays null');
            if ((await listedIds(world.owner, agent.name, 'exclude')).has(agent.id)) {
                findings.add('GET /agents: a deleted agent is still listed by default');
            }
            if (!(await listedIds(world.owner, agent.name, 'only')).has(agent.id)) {
                findings.add('GET /agents?deleted=only: the deleted agent is missing');
            }
            const restored = await world.owner.ok(R.restoreAgent, { params });
            if (restored.deletedAt !== null) findings.add('POST /agents/{agentId}/restore: deletedAt is still set');
            if (!(await listedIds(world.owner, agent.name, 'exclude')).has(agent.id)) {
                findings.add('GET /agents: a restored agent is not listed again');
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.agents.validate-diagnostics',
        suite: SUITE,
        title: 'Validating a broken book reports an error diagnostic, and creating from it is refused with 422',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.bookEditor);
            const findings = new Findings();
            const broken = await world.owner.ok(R.validateAgentSource, { body: { source: BROKEN_BOOK } });
            if (!broken.some(({ severity }) => severity === 'error')) {
                findings.add('POST /agents/validate: a broken book gets no error diagnostic');
            }
            const valid = await world.owner.ok(R.validateAgentSource, {
                body: { source: validBook(world.name('valid')) },
            });
            if (valid.some(({ severity }) => severity === 'error')) {
                findings.add('POST /agents/validate: the valid fixture book gets an error diagnostic');
            }
            await attempt(findings, async () => {
                await world.owner.problem(R.createAgent, { body: { source: BROKEN_BOOK } }, 'invalid-book');
            });
            return findings.outcome();
        },
    },
];

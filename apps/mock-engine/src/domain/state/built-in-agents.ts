import type { InMemorySeedAgent } from '@ptbk/engine-api/in-memory';

/**
 * The agents a Reborn engine always has (its specs/agents/core-agents.md and system-agents.md): the core roles it
 * prepares as project Books, and Expert, which it defines itself. Each Book's PERSONA is the one-line role the
 * Agents list shows. Fixed IDs, so the seeded sequence and every other seeded ID stay as they were.
 */
const BUILT_IN_AGENTS = [
    {
        id: 'builtin-chatter',
        name: 'Chatter',
        origin: 'core',
        role: 'Talks with you first, briefs you and brings in the right agents.',
    },
    {
        id: 'builtin-adam',
        name: 'Adam',
        origin: 'core',
        role: 'The common instructions every project agent builds on.',
    },
    { id: 'builtin-tasker', name: 'Tasker', origin: 'core', role: 'Creates, clarifies and keeps track of tasks.' },
    { id: 'builtin-router', name: 'Router', origin: 'core', role: 'Picks the agent and the model for each task.' },
    { id: 'builtin-fixer', name: 'Fixer', origin: 'core', role: 'Solves problems with the project and the engine.' },
    {
        id: 'builtin-teacher',
        name: 'Teacher',
        origin: 'core',
        role: 'Learns from finished work so the agents improve.',
    },
    {
        id: 'builtin-expert',
        name: 'Expert',
        origin: 'system',
        role: 'Knows Promptbook and this engine, and sets up new projects.',
    },
] as const;

export function builtInAgents(ownerId: string, createdAt: string): InMemorySeedAgent[] {
    return BUILT_IN_AGENTS.map(({ id, name, origin, role }) => ({
        id,
        source: `${name}\nPERSONA ${role}`,
        origin,
        createdBy: ownerId,
        createdAt,
        visibility: 'private',
    }));
}

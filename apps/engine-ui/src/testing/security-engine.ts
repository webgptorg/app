import type { EngineApiClient, Permission } from '@ptbk/engine-api';
import { createInMemoryEngine } from '@ptbk/engine-api/in-memory';
import type { InMemoryEngineController, InMemorySeed } from '@ptbk/engine-api/in-memory';

import { TEST_NOW } from './test-engine-api';

export const OWNER_ID = 'member-owner';

export interface SecurityEngineOptions {
    readonly permissions?: readonly Permission[];
    readonly stepUp?: 'satisfied' | 'required';
    /** Replaces parts of the default seed (engine, members, passkeys, sessions, secrets, security…). */
    readonly seed?: InMemorySeed;
}

export interface SecurityEngine {
    readonly client: EngineApiClient;
    readonly controller: InMemoryEngineController;
}

/** The in-memory engine as the security, members and secrets screens see it, with a lever for the overview. */
export function createSecurityEngine(options: SecurityEngineOptions = {}): SecurityEngine {
    return createInMemoryEngine({
        clock: { now: () => TEST_NOW },
        seed: {
            engine: { name: 'Test engine', hostname: 'engine.localhost', dashboardUrl: null, mode: 'local' },
            agents: [{ id: 'agent-ada', source: 'Ada\nPERSONA Research' }],
            ...options.seed,
        },
        ...(options.permissions === undefined
            ? {}
            : { member: { id: OWNER_ID, permissions: options.permissions, role: 'member' } }),
        ...(options.stepUp === undefined ? {} : { stepUp: options.stepUp }),
    });
}

/** Every piece of text and every attribute value in the document, to prove a value never reached it. */
export function documentText(): string {
    const parts: string[] = [document.body.textContent];
    for (const element of document.querySelectorAll('*')) {
        for (const attribute of element.attributes) parts.push(attribute.value);
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) parts.push(element.value);
    }
    return parts.join('\n');
}

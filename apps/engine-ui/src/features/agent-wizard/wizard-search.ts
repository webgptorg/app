import { AgentId, ChatId } from '@ptbk/engine-api';
import { z } from 'zod';

export const WIZARD_STEPS = ['brief', 'book', 'knowledge', 'test'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** Steps after the agent exists; they need its ID, which the URL carries so a reload keeps the place. */
export const CREATED_STEPS: ReadonlySet<WizardStep> = new Set(['knowledge', 'test']);

/**
 * The wizard's place in the URL. The brief and the book draft are never in it (nor in browser storage): a reload
 * before the agent exists starts over. A bad value falls back instead of throwing. `chat` is the kept test chat of an
 * engine without throwaway test chats.
 */
export const WizardSearch = z.object({
    step: z.enum(WIZARD_STEPS).default('brief').catch('brief'),
    agent: AgentId.optional().catch(undefined),
    chat: ChatId.optional().catch(undefined),
});
export type WizardSearch = z.output<typeof WizardSearch>;

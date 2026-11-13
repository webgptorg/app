import type { ReadParticipantRef } from '@ptbk/engine-api';

const HUES = 8;

/**
 * The class that gives a row its agent's colour (`--chat-agent`): a stable hue from the agent's key, the same in every
 * thread. The User and an unknown author keep the accent.
 */
export function agentTintClass(who: ReadParticipantRef | null): string | undefined {
    if (who?.kind !== 'agent') return undefined;
    let hash = 0;
    for (const char of who.key) hash = (Math.imul(hash, 31) + (char.codePointAt(0) ?? 0)) | 0;
    return `chat-hue-${String(Math.abs(hash) % HUES)}`;
}

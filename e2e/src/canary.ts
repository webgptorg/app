/*
 * "A secret never comes back": the checks the secrets and integrations flows run on a canary value after the UI has
 * handled it, with positive controls showing that each recorder did see traffic.
 */
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

import { browserStorageText } from './browser-storage.ts';
import type { ResponseRecorder } from './response-recorder.ts';
import { responsesContaining } from './response-recorder.ts';

/** A value nobody could have seeded: generated per run, never written to the repository or a log. */
export function newCanary(): string {
    return `canary-${crypto.randomUUID()}`;
}

export interface CanaryWitnesses {
    readonly page: Page;
    readonly responses: ResponseRecorder;
    readonly consoleMessages: readonly string[];
    /** Text the recorded responses must contain, proving the recorder read the engine's answers (e.g. a secret name). */
    readonly seenInResponses: string;
}

export async function expectCanariesAbsent(canaries: readonly string[], witnesses: CanaryWitnesses): Promise<void> {
    const { page, responses, consoleMessages, seenInResponses } = witnesses;
    const recorded = await responses.settled();
    const storage = await browserStorageText(page);
    const content = await page.content();
    expect(recorded.length, 'the recorder read responses').toBeGreaterThan(0);
    expect(
        responsesContaining(recorded, seenInResponses).length,
        `a response mentions ${seenInResponses}`,
    ).toBeGreaterThan(0);
    for (const canary of canaries) {
        expect(content.includes(canary), 'the canary is not in the page').toBe(false);
        expect(responsesContaining(recorded, canary), 'responses carrying the canary').toEqual([]);
        expect(storage.includes(canary), 'the canary is not in browser storage').toBe(false);
        expect(
            consoleMessages.filter((message) => message.includes(canary)),
            'console output with the canary',
        ).toEqual([]);
    }
}

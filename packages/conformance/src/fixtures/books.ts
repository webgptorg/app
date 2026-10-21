/**
 * Synthetic books: no real names, keys or tokens. The name is the first line and also part of the persona, so a
 * search finds the agent by its `conformance-<runId>-` prefix whichever field an engine derives the name from.
 */
export function validBook(name: string): string {
    return [
        name,
        '',
        `PERSONA ${name} is a synthetic agent created by the conformance suite. It has no knowledge and no tools.`,
        'META COLOR #3366cc',
        'INITIAL MESSAGE Hello, I only exist for a conformance run.',
        '',
    ].join('\n');
}

/** Empty: a book's first line names the agent, so an empty book has nothing to name and must be an error. */
export const BROKEN_BOOK = '';

export const CHAT_MESSAGE = 'Hello from the conformance suite. Please answer with a short paragraph.';

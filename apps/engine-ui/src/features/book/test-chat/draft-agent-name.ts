/** The name a book gives its agent, by the book language's rule: its first non-blank line; `null` for a blank book. */
export function draftAgentName(source: string): string | null {
    const line = source.split(/\r\n|\r|\n/).find((candidate) => candidate.trim() !== '');
    return line === undefined ? null : line.trim().slice(0, 256);
}

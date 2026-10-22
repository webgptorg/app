export interface Brief {
    readonly name: string;
    readonly description: string;
}

/**
 * The first draft of a book from the brief, used while the engine offers no draft endpoint: the name on the first
 * line, the description as the persona. Whitespace is collapsed so neither can start a line of its own.
 */
export function bookTemplate({ name, description }: Brief): string {
    const persona = description.replace(/\s+/g, ' ').trim();
    const title = name.replace(/\s+/g, ' ').trim();
    return persona === '' ? `${title}\n` : `${title}\n\nPERSONA ${persona}\n`;
}

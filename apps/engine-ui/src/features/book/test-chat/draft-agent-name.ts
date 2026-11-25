import { Book } from 'ptbk';

/** The public parser understands both canonical declarations and the former plain-name syntax. */
export function draftAgentName(source: string): string | null {
    return Book.parse(source).name.slice(0, 256) || null;
}

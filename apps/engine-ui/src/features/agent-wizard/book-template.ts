import { Book } from 'ptbk';

export interface Brief {
    readonly name: string;
    readonly description: string;
}

/** The engine's writer keeps names and literal persona text representable in Book notation. */
export function bookTemplate({ name, description }: Brief): string {
    const agent = Book.create('agent', name);
    const persona = description.replace(/\s+/g, ' ').trim();
    if (persona) agent.addCommitment('PERSONA', persona);
    return agent.toString();
}

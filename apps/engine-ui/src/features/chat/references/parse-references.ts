/** Names a reference may resolve to; anything else stays text. */
export interface ReferenceIndex {
    /** Longest name first, so `@Copy Writer` wins over `@Copy`. */
    readonly agents: readonly { readonly key: string; readonly name: string }[];
    readonly tasks: ReadonlySet<string>;
}

export type ReferenceSegment =
    | { readonly kind: 'text'; readonly text: string }
    /**
     * `@Name`, or `+@Name` when the message addresses the agent (`addressed`). `text` is the mention as written, `@`
     * included: an inflected `@Copywritera` keeps its ending.
     */
    | {
          readonly kind: 'agent';
          readonly key: string;
          readonly name: string;
          readonly text: string;
          readonly addressed: boolean;
      }
    | { readonly kind: 'task'; readonly name: string }
    /** `+@User`: the agent asks the User something. */
    | { readonly kind: 'asks-user' };

/** The engine's own name for the human side of a thread, as agents write it. */
export const USER_REFERENCE_NAME = 'User';
/** Book task names are at most this long (`ChatTask.name`); a longer `{…}` is never a reference. */
const MAX_TASK_NAME_LENGTH = 512;

const NAME_CHAR = /[\p{L}\p{N}_-]/u;
const isNameChar = (char: string | undefined) => char !== undefined && NAME_CHAR.test(char);
/**
 * Czech declines names (`@Copywritera`, `@Copywriterovi`): a name followed by one of these case endings still refers
 * to the agent. A closed list, so English words (`@Chattering`) and plurals stay text.
 */
const CASE_ENDINGS: ReadonlySet<string> = new Set([
    'a',
    'e',
    'ě',
    'i',
    'u',
    'y',
    'o',
    'em',
    'ou',
    'ovi',
    'ům',
    'ech',
    'ové',
    'ů',
]);
const LONGEST_ENDING = 3;

/** Where a name followed by a case ending ends, or `null` when what follows is no such ending. */
function inflectedEnd(text: string, from: number): number | null {
    for (let length = LONGEST_ENDING; length >= 1; length -= 1) {
        const end = from + length;
        if (CASE_ENDINGS.has(text.slice(from, end).toLowerCase()) && !isNameChar(text[end])) return end;
    }
    return null;
}

export function createReferenceIndex(
    agents: readonly { readonly key: string; readonly name: string }[],
    tasks: Iterable<string>,
): ReferenceIndex {
    const byName = new Map<string, { readonly key: string; readonly name: string }>();
    // The first entry of a name wins: callers list thread members before the project's other agents.
    for (const agent of agents) {
        const name = agent.name.trim();
        if (name !== '' && !byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), { key: agent.key, name });
    }
    return {
        agents: [...byName.values()].sort((a, b) => b.name.length - a.name.length),
        tasks: new Set(tasks),
    };
}

function startsWithName(text: string, at: number, name: string): boolean {
    const candidate = text.slice(at, at + name.length);
    return candidate.length === name.length && candidate.toLowerCase() === name.toLowerCase();
}

interface Match {
    readonly segment: Exclude<ReferenceSegment, { kind: 'text' }>;
    readonly end: number;
}

/** `@Name`, `+@Name` or `+@User` starting at `at` (the `+` or `@`), when the name is a whole word. */
function matchMention(text: string, at: number, index: ReferenceIndex): Match | null {
    const addressed = text[at] === '+';
    const nameStart = at + (addressed ? 2 : 1);
    if (addressed && startsWithName(text, nameStart, USER_REFERENCE_NAME)) {
        const end = nameStart + USER_REFERENCE_NAME.length;
        if (!isNameChar(text[end])) return { segment: { kind: 'asks-user' }, end };
    }
    let inflected: Match | null = null;
    for (const agent of index.agents) {
        if (!startsWithName(text, nameStart, agent.name)) continue;
        const nameEnd = nameStart + agent.name.length;
        const end = isNameChar(text[nameEnd]) ? inflectedEnd(text, nameEnd) : nameEnd;
        if (end === null) continue;
        const match = {
            segment: {
                kind: 'agent',
                key: agent.key,
                name: agent.name,
                text: text.slice(nameStart - 1, end),
                addressed,
            },
            end,
        } as const;
        // An exact name wins over another agent's name with an ending: `@Adam` is Adam, not Ada declined.
        if (end === nameEnd) return match;
        inflected ??= match;
    }
    return inflected;
}

/** `{Task name}` starting at `at`, on one line, naming a task of this thread. */
function matchTask(text: string, at: number, index: ReferenceIndex): Match | null {
    // Only a name's length ahead: a text full of `{` must not make every one scan to the end.
    const window = text.slice(at + 1, at + 2 + MAX_TASK_NAME_LENGTH);
    const close = window.indexOf('}');
    if (close === -1) return null;
    const inner = window.slice(0, close);
    if (inner.includes('\n')) return null;
    const name = index.tasks.has(inner) ? inner : inner.trim();
    return index.tasks.has(name) ? { segment: { kind: 'task', name }, end: at + close + 2 } : null;
}

/**
 * Finds agent mentions, `+@User` and `{task}` references in plain text (a markdown text node or a plain message),
 * never in markup. Only names the thread knows become references; everything else, `{` without its `}` included,
 * stays exactly the text it was. A mention needs a word boundary before it, so `ada@example.com` is no mention.
 */
export function parseReferences(text: string, index: ReferenceIndex): ReferenceSegment[] {
    const segments: ReferenceSegment[] = [];
    let plainFrom = 0;
    let at = 0;
    while (at < text.length) {
        const char = text[at];
        let match: Match | null = null;
        if (char === '{' && index.tasks.size > 0) {
            match = matchTask(text, at, index);
        } else if ((char === '@' || (char === '+' && text[at + 1] === '@')) && !isNameChar(text[at - 1])) {
            match = matchMention(text, at, index);
        }
        if (match === null) {
            at += 1;
            continue;
        }
        if (at > plainFrom) segments.push({ kind: 'text', text: text.slice(plainFrom, at) });
        segments.push(match.segment);
        at = match.end;
        plainFrom = at;
    }
    if (plainFrom < text.length) segments.push({ kind: 'text', text: text.slice(plainFrom) });
    return segments;
}

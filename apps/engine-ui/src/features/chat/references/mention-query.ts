/** The `@…` being typed at the caret: where it starts and ends, what is typed so far, and whether it is `+@`. */
export interface MentionQuery {
    /** Index of the `@`, or of the `+` of `+@`. */
    readonly start: number;
    /** The caret. */
    readonly end: number;
    readonly text: string;
    /** `+@`: the member addresses the agent rather than mentioning it. */
    readonly addressing: boolean;
}

/** Long enough for any agent name a member types before picking it; a longer run is not a mention. */
const MAX_QUERY_LENGTH = 48;
const BOUNDARY = /[\s([{"'„“«]/u;

/** The mention at the caret, if the caret sits right after `@` or `+@` and a few characters of a name. */
export function findMentionQuery(text: string, caret: number): MentionQuery | null {
    const from = Math.max(0, caret - MAX_QUERY_LENGTH - 2);
    for (let at = caret - 1; at >= from; at -= 1) {
        const char = text[at];
        if (char === '\n') return null;
        if (char !== '@') continue;
        const query = text.slice(at + 1, caret);
        if (query.startsWith(' ') || query.includes('  ')) return null;
        const addressing = text[at - 1] === '+';
        const start = addressing ? at - 1 : at;
        const before = text[start - 1];
        if (before !== undefined && !BOUNDARY.test(before)) return null;
        return { start, end: caret, text: query, addressing };
    }
    return null;
}

export interface MentionCandidate {
    readonly key: string;
    readonly name: string;
}

/** Names that start with the query, or have a word that does; in the given order (members first), at most `limit`. */
export function matchMentionCandidates<Candidate extends MentionCandidate>(
    candidates: readonly Candidate[],
    query: string,
    limit: number,
): Candidate[] {
    const needle = query.toLocaleLowerCase();
    const starts: Candidate[] = [];
    const words: Candidate[] = [];
    for (const candidate of candidates) {
        const name = candidate.name.toLocaleLowerCase();
        if (name.startsWith(needle)) starts.push(candidate);
        else if (name.split(/\s+/u).some((word) => word.startsWith(needle))) words.push(candidate);
    }
    return [...starts, ...words].slice(0, limit);
}

/** The text with the query replaced by `@Name ` (or removed, when it addressed), and where the caret goes. */
export function applyMention(
    text: string,
    query: MentionQuery,
    name: string,
): { readonly text: string; readonly caret: number } {
    const after = text.slice(query.end);
    if (query.addressing) {
        const rest = query.start === 0 ? after.replace(/^ /u, '') : after;
        return { text: text.slice(0, query.start) + rest, caret: query.start };
    }
    const inserted = `@${name}${after.startsWith(' ') ? '' : ' '}`;
    return {
        text: text.slice(0, query.start) + inserted + after,
        caret: query.start + inserted.length + (after.startsWith(' ') ? 1 : 0),
    };
}

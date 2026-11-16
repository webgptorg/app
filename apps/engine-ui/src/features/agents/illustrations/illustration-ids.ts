// The IDs alone, apart from the drawings: avatars resolve an ID in the entry, and the drawings load as a chunk of their own.
/** The curated set, in the order the product owner approved it; an engine may name one in `profile.illustration`. */
export const ILLUSTRATION_IDS = [
    'chatter',
    'adam',
    'tasker',
    'router',
    'fixer',
    'teacher',
    'expert',
    'copywriter',
    'developer',
    'lawyer',
    'planner',
    'agent',
    'support',
    'analyst',
    'designer',
    'mail',
    'finance',
    'marketing',
    'security',
    'launch',
] as const;
export type IllustrationId = (typeof ILLUSTRATION_IDS)[number];

const KNOWN: ReadonlySet<string> = new Set(ILLUSTRATION_IDS);

export function isIllustrationId(value: string): value is IllustrationId {
    return KNOWN.has(value);
}

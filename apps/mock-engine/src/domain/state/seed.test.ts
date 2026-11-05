import type { ActivityItem, ActivityPageRead, EngineApiClient, EngineApiResponse } from '@ptbk/engine-api';
import { ChatId, KNOWN_CAPABILITIES, MAX_RUN_TEXT_BYTES, TaskId } from '@ptbk/engine-api';
import { createInMemoryEngine } from '@ptbk/engine-api/in-memory';
import type { InMemorySeed } from '@ptbk/engine-api/in-memory';
import { describe, expect, it } from 'vitest';

import { RUN_ERRORS } from './capability-texts';

import { SCENARIOS } from './scenarios';
import type { Scenario } from './scenarios';
import { HOSTILE_AGENT_NAME, HOSTILE_AUDIT_TARGET_NAME, ownerOf, seedEngine } from './seed';

const EPOCH = new Date('2026-10-01T00:00:00Z');
const HOSTNAME = 'abcdefghijklmnopqrstuvwxyz.engine.test';
const seedFor = (seed: number, scenario: Scenario, epoch = EPOCH): Promise<InMemorySeed> =>
    seedEngine({ seed, scenario, epoch, hostname: HOSTNAME });
const signal = () => AbortSignal.timeout(5_000);

function ok<T>(response: EngineApiResponse<T>): T {
    if (response.kind !== 'ok') throw new Error(`Expected ok, got problem ${response.problem.code}`);
    return response.data;
}

async function sha256(text: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function core(scenario: Scenario, seed = 42) {
    const data = await seedFor(seed, scenario);
    const engine = createInMemoryEngine({
        seed: data,
        member: { id: ownerOf(data), role: 'owner' },
        clock: { now: () => EPOCH },
        // With scanning, so the seeded scan results show; without it every scan reads `null`.
        capabilities: Object.values(KNOWN_CAPABILITIES),
    });
    return { data, ...engine };
}

/** Schedules and task plans look ahead: when they fire or start next, and when work is due. The rest happened. */
const FUTURE_KEYS = new Set(['nextFireAt', 'recurrence', 'notBefore', 'dueAt', 'nextAt', 'scheduledFor']);

/** Every timestamp in the seed, wherever it sits, except a schedule's future. */
function timestamps(value: unknown, found: string[] = []): string[] {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) found.push(value);
    else if (typeof value === 'object' && value !== null)
        for (const [key, item] of Object.entries(value)) if (!FUTURE_KEYS.has(key)) timestamps(item, found);
    return found;
}

/** Every item of a list route, page by page. */
async function all<T>(
    list: (cursor: string | undefined) => Promise<EngineApiResponse<{ items: T[]; nextCursor: string | null }>>,
) {
    const items: T[] = [];
    let cursor: string | undefined;
    do {
        const page = ok(await list(cursor));
        items.push(...page.items);
        cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return items;
}

const runsOf = (client: EngineApiClient) =>
    all((cursor) => client.runs.list({ limit: 100, ...(cursor === undefined ? {} : { cursor }) }, signal()));

describe('seedEngine', () => {
    // The hash covers every record, files by their SHA-256 (JSON drops the Blob contents), so it moves with any change
    // to the generated data; a deliberate change updates it here.
    it('gives a stable small-team seed for seed 42 and a fixed epoch, including every capability', async () => {
        const data = await seedFor(42, 'small-team');
        expect(await sha256(JSON.stringify(data))).toBe(
            '53fded270e482adac280573cdf6a244236cfcdb31d3dce2d1bab84403893e475',
        );
        for (const key of ['runs', 'files', 'triggers', 'integrations', 'activity'] as const) {
            expect(data[key]?.length, key).toBeGreaterThan(0);
        }
    });

    it('is byte-identical for the same inputs and changes with the seed, scenario or epoch', async () => {
        const once = JSON.stringify(await seedFor(42, 'small-team'));
        expect(JSON.stringify(await seedFor(42, 'small-team'))).toBe(once);
        expect(JSON.stringify(await seedFor(43, 'small-team'))).not.toBe(once);
        expect(JSON.stringify(await seedFor(42, 'empty'))).not.toBe(once);
        expect(JSON.stringify(await seedFor(42, 'small-team', new Date('2026-11-01T00:00:00Z')))).not.toBe(once);
        const files = (data: InMemorySeed) => Promise.all((data.files ?? []).map(({ content }) => content.text()));
        expect(await files(await seedFor(42, 'small-team'))).toEqual(await files(await seedFor(42, 'small-team')));
    });

    it.each(SCENARIOS)(
        'seeds %s into a working core with second-precision timestamps',
        async (scenario) => {
            const { data, client } = await core(scenario);
            const me = ok(await client.me.get(signal()));
            expect(me).toMatchObject({ memberId: ownerOf(data), role: 'owner' });
            const members = ok(await client.members.list({ limit: 100 }, signal())).items;
            expect(members).toHaveLength(data.members?.length ?? 0);
            expect(ok(await client.audit.verify(signal())).status).toBe('intact');
            for (const at of timestamps({ ...data, sessions: [] })) {
                expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
                expect(Date.parse(at)).toBeLessThanOrEqual(EPOCH.getTime());
            }
        },
        30_000,
    );

    it('seeds only the owner for empty', async () => {
        const data = await seedFor(1, 'empty');
        expect(data.members?.map(({ role }) => role)).toEqual(['owner']);
        expect(data.agents?.map(({ origin }) => origin)).toEqual([
            ...Array.from({ length: 6 }, () => 'core'),
            'system',
        ]);
        expect(data.chats).toEqual([]);
        expect(data.secrets).toEqual([]);
        expect(data.passkeys).toHaveLength(1);
        for (const key of ['runs', 'files', 'triggers', 'integrations', 'activity'] as const)
            expect(data[key]).toEqual([]);
    });

    it('gives small-team every role, a hostile agent, visitor chats and enough passkeys to test last-passkey', async () => {
        const { data, client } = await core('small-team');
        const roles = data.members?.map(({ role }) => role).sort();
        expect(roles).toEqual(['admin', 'member', 'member', 'owner', 'viewer']);
        const agents = ok(await client.agents.list({ deleted: 'include', limit: 100 }, signal())).items;
        expect(agents.length).toBeGreaterThanOrEqual(7);
        expect(agents.filter(({ deletedAt }) => deletedAt !== null)).toHaveLength(1);
        expect(agents.map(({ name }) => name)).toContain(HOSTILE_AGENT_NAME);
        const audit = ok(await client.audit.list({ action: 'agent.source.update', limit: 100 }, signal())).items;
        expect(audit.map(({ target }) => target?.name)).toContain(HOSTILE_AUDIT_TARGET_NAME);
        const created = ok(await client.audit.list({ action: 'agent.create', limit: 100 }, signal())).items;
        expect(created.map(({ target }) => target?.name)).toContain(HOSTILE_AGENT_NAME);
        expect(created[0]?.details).toMatchObject({ fields: expect.arrayContaining(['source']) as unknown });
        expect(new Set(agents.map(({ visibility }) => visibility)).size).toBeGreaterThan(1);
        const owner = ownerOf(data);
        expect(data.passkeys?.filter(({ memberId }) => memberId === owner).length).toBeGreaterThanOrEqual(2);
        for (const member of data.members?.filter(({ role }) => role === 'member') ?? []) {
            expect(
                agents.some(({ createdBy }) => createdBy === member.id),
                member.id,
            ).toBe(true);
        }
        const chats = ok(await client.chats.listAll({ limit: 100 }, signal())).items;
        expect(chats.length).toBeGreaterThanOrEqual(7);
        const [chat] = chats;
        if (chat) expect(ok(await client.chats.listEntries(chat.id, {}, signal())).items.length).toBeGreaterThan(2);
        const byId = new Map(chats.map((thread) => [thread.id, thread]));
        expect(byId.get(ChatId.parse('chat-agents-talking'))?.members.map(({ kind }) => kind)).toEqual([
            'agent',
            'agent',
        ]);
        expect(byId.get(ChatId.parse('Report'))?.members.map(({ name }) => name)).toEqual(['Chatter']);
        expect(byId.get(ChatId.parse('chat-question-for-you'))).toMatchObject({
            status: 'waiting-for-user',
            questions: [{ seen: false }],
        });
        expect(byId.get(ChatId.parse('chat-chatter-brings-in'))?.members.map(({ kind }) => kind)).toEqual([
            'user',
            'agent',
            'agent',
        ]);
        const secrets = ok(await client.secrets.list({ limit: 100 }, signal())).items;
        expect(secrets.map(({ status }) => status)).toContain('revoked');
        expect(new Set(secrets.map(({ scope }) => scope.kind))).toEqual(new Set(['engine', 'agent']));
    });

    it('describes every passkey, counts them per member and names the passkey each session signed in with', async () => {
        const { data, client } = await core('small-team');
        const passkeys = ok(await client.passkeys.list({ limit: 100 }, signal())).items;
        expect(passkeys.every(({ authenticator }) => authenticator !== null)).toBe(true);
        expect(new Set(passkeys.map(({ authenticator }) => authenticator?.attachment))).toEqual(
            new Set(['platform', 'cross-platform']),
        );
        for (const member of ok(await client.members.list({ limit: 100 }, signal())).items) {
            expect(member.passkeyCount, member.id).toBe(
                passkeys.filter(({ memberId }) => memberId === member.id).length,
            );
        }
        const owners = new Map<string, string>(passkeys.map(({ id, memberId }) => [id, memberId]));
        const sessions = data.sessions ?? [];
        expect(sessions.length).toBeGreaterThan(0);
        for (const session of sessions) expect(owners.get(session.passkeyId ?? ''), session.id).toBe(session.memberId);
    });

    it('keeps secrets metadata-only', async () => {
        for (const scenario of SCENARIOS) {
            for (const secret of (await seedFor(5, scenario)).secrets ?? []) {
                expect(Object.keys(secret).sort()).toEqual(
                    ['createdAt', 'createdBy', 'id', 'lastUsedAt', 'name', 'scope', 'status', 'updatedAt'].sort(),
                );
            }
        }
    });

    // The budget is for generating the data; parsing it into the core is engine-api's cost and comes on top.
    it('seeds large-fleet in under 3 s, into a core with chats long enough to page', async () => {
        const started = performance.now();
        const data = await seedFor(42, 'large-fleet');
        expect(performance.now() - started).toBeLessThan(3_000);
        const client = createInMemoryEngine({
            seed: data,
            member: { id: ownerOf(data), role: 'owner' },
            clock: { now: () => EPOCH },
        }).client;
        expect(data.agents?.filter(({ origin }) => origin === undefined)).toHaveLength(500);
        // The same mix as small-team, scaled for paging.
        expect(data.runs?.length).toBeGreaterThan(18_000);
        expect(data.files?.length).toBeGreaterThan(2_700);
        expect(data.triggers).toHaveLength(500);
        expect(data.integrations).toHaveLength(300);
        expect(data.activity?.length).toBeGreaterThan(45_000);
        expect(ok(await client.runs.list({ limit: 100 }, signal())).nextCursor).not.toBeNull();
        expect(data.members?.length).toBe(40);
        expect(new Set(data.members?.map(({ role }) => role))).toEqual(new Set(['owner', 'admin', 'member', 'viewer']));
        const counts = (data.chats ?? []).map(({ entries }) => entries.filter(({ type }) => type === 'message').length);
        expect(counts.filter((count) => count >= 150).length).toBeGreaterThanOrEqual(3);
        expect(ok(await client.agents.list({ limit: 100 }, signal())).nextCursor).not.toBeNull();
    }, 30_000);
});

describe('seedEngine: capabilities in small-team', () => {
    it('seeds a task inventory with every relation the engine models, its runs linked to their occurrences', async () => {
        const { client } = await core('small-team');
        const tasks = ok(await client.tasks.list({ limit: 100 }, signal())).items;
        const byKey = new Map<string, (typeof tasks)[number]>(tasks.map((task) => [task.id, task]));
        const states = new Set(tasks.map(({ state }) => state));
        for (const state of [
            'active',
            'awaiting-user',
            'blocked',
            'waiting-dependency',
            'done',
            'cancelled',
            'retired',
        ]) {
            expect(states, state).toContain(state);
        }
        expect(tasks.filter(({ kind }) => kind === 'engine').map(({ name }) => name)).toEqual([
            'Update Promptbook 0.119.0 → 0.120.0',
        ]);
        const launch = ok(await client.tasks.get(TaskId.parse('task-launch-newsletter'), signal()));
        expect(launch.children.length).toBeGreaterThanOrEqual(4);
        expect(launch.links.some(({ target }) => target.type === 'chat' && target.chatId !== null)).toBe(true);
        expect(launch.origin?.kind).toBe('chat');
        const send = byKey.get('task-send-first-issue');
        expect(send?.dependsOn.map(({ state }) => state)).toEqual(['met', 'pending']);
        expect(byKey.get('task-pricing-typo')?.reopened).toBe(true);

        const digest = TaskId.parse('task-weekly-digest');
        const occurrences = ok(await client.tasks.listOccurrences(digest, {}, signal())).items;
        expect(occurrences.map(({ reason }) => reason)).toEqual(['repeat', 'retry', 'repeat', 'first']);
        const ran = occurrences.flatMap(({ runIds }) => runIds);
        expect(ran.length).toBe(3);
        const runs = ok(await client.runs.list({ taskId: digest }, signal())).items;
        expect(runs.map(({ id }) => id).sort()).toEqual([...ran].sort());
        for (const run of runs) expect(run.occurrenceId).not.toBeNull();
    });

    it('seeds about 200 runs over 14 days with every source, every status and believable failures', async () => {
        const { client } = await core('small-team');
        const runs = await runsOf(client);
        expect(runs.length).toBeGreaterThan(150);
        expect(runs.length).toBeLessThan(260);
        expect(new Set(runs.map(({ source }) => source))).toEqual(
            new Set(['web', 'api', 'email', 'schedule', 'member', 'goal', 'webhook']),
        );
        expect(new Set(runs.map(({ status }) => status))).toEqual(
            new Set(['queued', 'running', 'completed', 'failed', 'cancelled']),
        );
        const oldest = Math.min(...runs.map(({ queuedAt }) => Date.parse(queuedAt)));
        expect(EPOCH.getTime() - oldest).toBeLessThanOrEqual(15 * 24 * 3600 * 1000);
        const codes = new Set(RUN_ERRORS.map(({ code }) => code));
        for (const failed of runs.filter(({ status }) => status === 'failed')) {
            expect(codes.has(failed.error?.code ?? ''), failed.id).toBe(true);
        }
        const finished = runs.filter(({ status }) => status === 'completed');
        expect(
            finished.every(({ usage }) => usage?.cost?.currency === 'USD' && /^\d+\.\d{4}$/.test(usage.cost.amount)),
        ).toBe(true);
        const retries = runs.filter(({ retryOf }) => retryOf !== null);
        expect(retries.length).toBeGreaterThan(0);
        const byId = new Map<string, (typeof runs)[number]>(runs.map((run) => [run.id, run]));
        for (const retry of retries) expect(byId.get(retry.retryOf ?? '')?.status, retry.id).toBe('failed');
        expect(ok(await client.runs.stats({}, signal()))).toMatchObject({ running: 2, queued: 2 });
    });

    it('links web runs to chat replies and gives other runs steps, tool calls in every state and project changes', async () => {
        const { client } = await core('small-team');
        const runs = await runsOf(client);
        for (const web of runs.filter(({ source }) => source === 'web')) {
            expect(web.chatId).not.toBeNull();
            const entries = ok(await client.chats.listEntries(web.chatId as never, { limit: 100 }, signal())).items;
            const reply = entries.find(({ id }) => id === web.messageId);
            expect(reply?.type === 'message' ? reply.author.kind : reply?.type, web.id).toBe('agent');
        }
        const details = await Promise.all(
            runs
                .filter(({ source }) => source !== 'web')
                .map(async ({ id }) => ok(await client.runs.get(id, signal()))),
        );
        expect(details.every(({ progress }) => progress !== null && progress.items.length > 0)).toBe(true);
        expect(new Set(details.flatMap(({ toolCalls }) => toolCalls.map(({ state }) => state)))).toEqual(
            new Set(['pending', 'partial', 'complete', 'error']),
        );
        const changes = details.flatMap(({ outputs }) => outputs.projectChanges);
        expect(changes.length).toBeGreaterThan(1);
        for (const change of changes) {
            expect(change.commitHash).toMatch(/^[0-9a-f]{40}$/);
            expect(change.changedFiles.length).toBeGreaterThan(0);
            expect(change.diff).toContain('diff --git');
        }
        const truncated = changes.filter(({ diffTruncated }) => diffTruncated);
        expect(truncated).toHaveLength(1);
        const [big] = truncated;
        expect(new TextEncoder().encode(big?.diff).byteLength).toBeGreaterThan(MAX_RUN_TEXT_BYTES - 200);
        const changed = details.filter(({ outputs }) => outputs.projectChanges.length > 0);
        expect(changed.every(({ report }) => report.touchedProjects.length === 1)).toBe(true);
    });

    it("names each run's agent and previews what started it, and names its output files", async () => {
        const { client } = await core('small-team');
        const runs = await runsOf(client);
        const agents = new Map(ok(await client.agents.list({ limit: 100 }, signal())).items.map((a) => [a.id, a.name]));
        for (const run of runs) {
            expect(run.agentName, run.id).toBe(agents.get(run.agentId));
            expect(run.preview, run.id).not.toBeNull();
        }
        const email = runs.filter(({ source }) => source === 'email').map(({ preview }) => preview);
        expect(email.length).toBeGreaterThan(0);
        expect(email.every((preview) => preview !== null && preview.length > 0)).toBe(true);
        const withFiles = await Promise.all(
            runs.slice(0, 120).map(async ({ id }) => ok(await client.runs.get(id, signal())).outputs),
        );
        for (const outputs of withFiles) expect(outputs.fileNames).toHaveLength(outputs.files.length);
        expect(withFiles.some(({ fileNames }) => fileNames.length > 0)).toBe(true);
    });

    it('seeds knowledge, attachments and outputs, a few PNGs, versions in git and scans that did not come back clean', async () => {
        const { data, client } = await core('small-team');
        const files = await all((cursor) =>
            client.files.list({ limit: 100, ...(cursor === undefined ? {} : { cursor }) }, signal()),
        );
        expect(new Set(files.map(({ purpose }) => purpose))).toEqual(
            new Set(['knowledge', 'attachment', 'output', 'upload']),
        );
        const live = (data.agents ?? []).filter(
            ({ deletedAt, origin }) => deletedAt === undefined && origin === undefined,
        );
        for (const agent of live) {
            expect(
                files.some(({ agentId, purpose }) => agentId === agent.id && purpose === 'knowledge'),
                agent.id,
            ).toBe(true);
        }
        expect(files.filter(({ scan }) => scan?.status === 'infected')).toHaveLength(1);
        expect(files.filter(({ scan }) => scan?.status === 'pending').length).toBeGreaterThanOrEqual(2);
        expect(files.filter(({ scan }) => scan?.status === 'failed').length).toBeGreaterThanOrEqual(2);
        const [infected] = files.filter(({ scan }) => scan?.status === 'infected');
        expect(infected && (await client.files.download(infected.id, {}, signal()))).toMatchObject({
            kind: 'problem',
            problem: { code: 'file-infected' },
        });
        const png = files.find(({ contentType }) => contentType === 'image/png');
        if (png === undefined) throw new Error('no PNG seeded');
        const bytes = new Uint8Array(await ok(await client.files.download(png.id, {}, signal())).arrayBuffer());
        expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        expect(bytes.byteLength).toBe(png.sizeBytes);
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        expect([...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')).toBe(png.sha256);
        const versioned = files.filter(({ versionCount }) => versionCount > 1);
        expect(versioned.length).toBeGreaterThan(0);
        for (const file of versioned) {
            const versions = ok(await client.files.listVersions(file.id, {}, signal())).items;
            expect(versions.every(({ commitHash, runId }) => commitHash !== null && runId !== null)).toBe(true);
        }
        const outputs = files.filter(({ purpose }) => purpose === 'output');
        for (const output of outputs) {
            expect(ok(await client.runs.get(output.runId as never, signal())).outputs.files, output.id).toContain(
                output.id,
            );
        }
    });

    it('seeds email and schedule triggers in every lifecycle, each with a fire history linked to its runs', async () => {
        const { client } = await core('small-team');
        const triggers = ok(await client.triggers.list({ limit: 100 }, signal())).items;
        expect(new Set(triggers.map(({ lifecycle }) => lifecycle))).toEqual(
            new Set(['active', 'paused', 'ended', 'failed']),
        );
        expect(new Set(triggers.map(({ endedReason }) => endedReason))).toEqual(
            new Set([null, 'completed', 'cancelled', 'max-runs']),
        );
        const schedules = triggers.flatMap((trigger) => (trigger.kind === 'schedule' ? [trigger] : []));
        expect(new Set(schedules.map(({ config }) => config.recurrence.kind))).toEqual(
            new Set(['once', 'interval', 'cron']),
        );
        const zones = schedules.flatMap(({ config }) =>
            config.recurrence.kind === 'cron' ? [config.recurrence.timeZone] : [],
        );
        expect(new Set(zones).size).toBeGreaterThan(2);
        for (const schedule of schedules) {
            expect(schedule.nextFireAt === null, schedule.name).toBe(schedule.lifecycle !== 'active');
            if (schedule.nextFireAt !== null) expect(Date.parse(schedule.nextFireAt)).toBeGreaterThan(EPOCH.getTime());
            if (schedule.config.maxRunCount !== null)
                expect(schedule.config.runCount).toBe(schedule.config.maxRunCount);
        }
        for (const email of triggers.filter(({ kind }) => kind === 'email')) {
            expect(email.kind === 'email' && email.config.address).toBe(`${email.id}@${HOSTNAME}`);
        }
        for (const trigger of triggers) {
            const fires = ok(await client.triggers.listFires(trigger.id, { limit: 100 }, signal())).items;
            const started = fires.filter(({ outcome }) => outcome === 'started');
            expect(started.length, trigger.name).toBeGreaterThan(0);
            for (const fire of started) {
                expect(ok(await client.runs.get(fire.runId as never, signal())).triggerId, trigger.name).toBe(
                    trigger.id,
                );
            }
        }
    });

    it('seeds MCP servers, calendars and repositories with their secrets by name, tools and every health', async () => {
        const { data, client } = await core('small-team');
        const integrations = ok(await client.integrations.list({ limit: 100 }, signal())).items;
        expect(new Set(integrations.map(({ kind }) => kind))).toEqual(
            new Set(['mcp-server', 'calendar', 'repository']),
        );
        expect(new Set(integrations.map(({ agentId }) => agentId === null))).toEqual(new Set([true, false]));
        expect(new Set(integrations.map(({ status }) => status))).toEqual(
            new Set(['connected', 'needs-attention', 'error', 'disconnected']),
        );
        const refs = integrations.flatMap(({ secretRefs }) => secretRefs);
        expect(new Set(refs.map(({ state }) => state))).toEqual(new Set(['resolved', 'missing', 'revoked']));
        const secrets = new Map((data.secrets ?? []).map((secret) => [secret.id, secret]));
        for (const ref of refs.filter(({ secretId }) => secretId !== null)) {
            expect(secrets.get(ref.secretId ?? '')?.name).toBe(ref.name);
            expect(secrets.get(ref.secretId ?? '')?.status).toBe(ref.state === 'revoked' ? 'revoked' : 'active');
        }
        expect(integrations.some(({ tools }) => tools.length > 0)).toBe(true);
    });

    it('seeds an activity feed in which every item is a known kind', async () => {
        const { client } = await core('small-team');
        const items: ActivityItem[] = [];
        let cursor: string | null = null;
        do {
            const page: ActivityPageRead = ok(
                await client.activity.list({ limit: 100, ...(cursor === null ? {} : { cursor }) }, signal()),
            );
            items.push(...page.items);
            cursor = page.nextCursor;
        } while (cursor !== null);
        expect(items.length).toBeGreaterThan(400);
        expect(items.every(({ kind }) => kind === 'known')).toBe(true);
        const kinds = new Set(
            items.flatMap((item) => (item.kind === 'known' ? [item.activity.kind.split('.')[0]] : [])),
        );
        expect(kinds).toEqual(new Set(['run', 'file', 'trigger', 'integration', 'member', 'engine']));
    });
});

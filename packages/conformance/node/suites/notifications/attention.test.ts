import { describe, expect, it } from 'vitest';

import type { Admitted, Answer, AttentionEngine, Beat } from './attention';
import { attentionRecipients, attentionSwitchedOff } from './attention';

type Defect =
    | 'names-owner'
    | 'leaks-title'
    | 'extra-kind'
    | 'duplicate'
    | 'huge-count'
    | 'not-a-list'
    | 'ignores-seen'
    | 'keeps-revoked'
    | 'sends-when-off'
    | 'no-project'
    | 'absent-when-on'
    | 'no-switch'
    | 'step-up'
    | 'no-settings'
    | 'no-session'
    | 'join-fails'
    | 'no-me'
    | 'seen-refused'
    | 'silent';

interface Item {
    readonly id: string;
    readonly memberId: string | null;
    readonly kind: string;
    readonly title: string;
    seen: boolean;
}

const answer = (status: number, body: Record<string, unknown> | null = null, code: string | null = null): Answer => ({
    status,
    code,
    body,
    cookie: null,
});

/** An engine kept as plain state, broken by `defects`; it beats whenever a check waits, so no check sleeps. */
function scripted(defects: readonly Defect[] = []): AttentionEngine {
    const broken = new Set(defects);
    let sharing = true;
    let counter = 0;
    const members = new Map<string, { dashboardUserId: string | null; active: boolean }>([
        ['owner-member', { dashboardUserId: broken.has('names-owner') ? 'stranger-user' : null, active: true }],
    ]);
    const items: Item[] = [];
    const pendingRevocations: string[] = [];
    const beats: Beat[] = [];

    function attention(): unknown {
        if (!sharing && !broken.has('sends-when-off')) return undefined;
        if (sharing && broken.has('absent-when-on')) return undefined;
        if (broken.has('not-a-list')) return { 'agent-waiting': 1 };
        const counts = new Map<string, Record<string, unknown>>();
        for (const item of items) {
            if (item.seen && !broken.has('ignores-seen')) continue;
            let to: string | undefined;
            if (item.memberId !== null) {
                const member = members.get(item.memberId);
                if (member?.dashboardUserId == null || (!member.active && !broken.has('keeps-revoked'))) continue;
                to = member.dashboardUserId;
            } else if (broken.has('no-project')) continue;
            const key = `${to ?? ''} ${item.kind}`;
            const entry = counts.get(key) ?? { ...(to === undefined ? {} : { to }), kind: item.kind, count: 0 };
            entry['count'] = (entry['count'] as number) + 1;
            if (broken.has('leaks-title')) entry['title'] = item.title;
            if (broken.has('huge-count')) entry['count'] = 2_000_000;
            counts.set(key, entry);
        }
        const entries = [...counts.values()];
        if (broken.has('extra-kind')) entries.push({ kind: 'chat-unread', count: 1 });
        if (broken.has('duplicate') && entries[0] !== undefined) entries.push(entries[0]);
        return entries;
    }

    function beat(): Beat {
        for (const dashboardUserId of pendingRevocations.splice(0)) {
            for (const member of members.values())
                if (member.dashboardUserId === dashboardUserId) member.active = false;
        }
        const body: Record<string, unknown> = { v: 2, seq: beats.length + 1 };
        const value = attention();
        if (value !== undefined) body['attention'] = value;
        const entry = { at: Date.now(), text: JSON.stringify(body) };
        beats.push(entry);
        return entry;
    }

    const sessionMember = (cookie: string | undefined) => cookie?.replace(/^s=/, '');

    return {
        owner: { cookie: 's=owner-member' },
        notifications: {
            raise({ memberId, kind, title }) {
                const id = `notification-${String(++counter).padStart(4, '0')}`;
                items.push({ id, memberId, kind, title, seen: false });
                return Promise.resolve(id);
            },
        },
        accepted: (since) => beats.filter((candidate) => candidate.at >= since),
        awaitBeat(since, count) {
            if (broken.has('silent')) return Promise.resolve('no heartbeat came');
            while (beats.filter((candidate) => candidate.at >= since).length < count) beat();
            const found = beats.filter((candidate) => candidate.at >= since)[count - 1];
            return Promise.resolve(found ?? 'no heartbeat came');
        },
        api(method, path, body, session) {
            const caller = sessionMember(session !== undefined && 'cookie' in session ? session.cookie : undefined);
            const route = `${method} ${path.replace('/api/v1', '')}`;
            switch (route) {
                case 'PUT /settings/dashboard-attention':
                    if (broken.has('no-switch')) return Promise.resolve(answer(404, null, 'capability-not-supported'));
                    if (broken.has('step-up')) return Promise.resolve(answer(401, null, 'step-up-required'));
                    sharing = (body as { enabled: boolean }).enabled;
                    return Promise.resolve(answer(200, { enabled: sharing }));
                case 'GET /settings':
                    return Promise.resolve(
                        answer(200, broken.has('no-settings') ? {} : { dashboardAttention: sharing }),
                    );
                case 'GET /me':
                    return Promise.resolve(answer(200, broken.has('no-me') ? {} : { memberId: caller }));
                case 'POST /me/notifications/seen': {
                    if (broken.has('seen-refused')) return Promise.resolve(answer(404, null, 'not-found'));
                    for (const id of (body as { ids: string[] }).ids) {
                        const item = items.find((candidate) => candidate.id === id && candidate.memberId === caller);
                        if (item !== undefined) item.seen = true;
                    }
                    return Promise.resolve(answer(200, {}));
                }
                default:
                    return Promise.resolve(answer(404));
            }
        },
        admit(): Promise<Admitted | string> {
            if (broken.has('join-fails')) return Promise.resolve('the join failed at options');
            const memberId = `joined-member-${String(++counter)}`;
            const dashboardUserId = `conformance-user-${String(counter)}`;
            members.set(memberId, { dashboardUserId, active: true });
            return Promise.resolve({
                memberId,
                dashboardUserId,
                session: broken.has('no-session') ? null : { cookie: `s=${memberId}` },
            });
        },
        revoke(dashboardUserId) {
            pendingRevocations.push(dashboardUserId);
            return Promise.resolve();
        },
    };
}

describe('the attention checks', () => {
    it('pass against an engine that follows ADR 0027', async () => {
        expect(await attentionRecipients.against(scripted())).toEqual({ kind: 'pass' });
        expect(await attentionSwitchedOff.against(scripted())).toEqual({ kind: 'pass' });
    });

    it.each<[Defect, RegExp]>([
        ['names-owner', /no approved ticket/],
        ['leaks-title', /engine content|carries title/],
        ['extra-kind', /unknown kind/],
        ['duplicate', /two entries/],
        ['huge-count', /outside/],
        ['not-a-list', /not a list/],
        ['ignores-seen', /saw/],
        ['keeps-revoked', /revoked/],
        ['no-project', /project-wide/],
        ['absent-when-on', /no attention/],
        ['no-switch', /answered 404/],
        ['no-session', /no session/],
        ['join-fails', /join failed/],
        ['no-me', /no memberId/],
        ['seen-refused', /got 404/],
        ['silent', /no heartbeat/],
    ])('recipients fails an engine with %s', async (defect, detail) => {
        const outcome = await attentionRecipients.against(scripted([defect]));
        expect(outcome).toMatchObject({ kind: 'fail' });
        expect(outcome.kind === 'fail' ? outcome.detail : '').toMatch(detail);
    });

    it.each<[Defect, RegExp]>([
        ['sends-when-off', /still carry/],
        ['no-settings', /no dashboardAttention/],
        ['no-switch', /answered 404/],
        ['silent', /no heartbeat/],
    ])('switched-off fails an engine with %s', async (defect, detail) => {
        const outcome = await attentionSwitchedOff.against(scripted([defect]));
        expect(outcome).toMatchObject({ kind: 'fail' });
        expect(outcome.kind === 'fail' ? outcome.detail : '').toMatch(detail);
    });

    it('skips when the switch wants a fresh passkey', async () => {
        for (const check of [attentionRecipients, attentionSwitchedOff]) {
            expect(await check.against(scripted(['step-up']))).toMatchObject({ kind: 'skip' });
        }
    });
});

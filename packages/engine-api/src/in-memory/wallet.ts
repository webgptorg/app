import { MAX_WALLET_FIELDS, WalletRecordId, WalletRequest, WalletRequestId } from '../capabilities/wallet';
import type { WalletRecord, WalletState } from '../capabilities/wallet';
import type { z } from 'zod';
import type { AddWalletRecordBody } from '../capabilities/wallet';
import { fail, invalid, notFound, ok, time } from './kit';
import type { EngineContext, HandlerContext, HandlerResult, Handlers } from './kit';

/**
 * The fake keeps no password and no field value: nothing in the contract reads them back, so it has no reason to hold
 * them, and a leak test against it can only pass for the right reason.
 */
export interface InMemoryWallet {
    state: WalletState;
    lockedRecords: number;
    readonly records: Map<string, WalletRecord>;
    readonly requests: Map<string, WalletRequest>;
}

type SaveBody = z.output<typeof AddWalletRecordBody>;

/** The engine's `maskAccount`: enough of the account to recognise it, never the whole username. */
export function maskAccount(username: string): string {
    const at = username.lastIndexOf('@');
    const local = at === -1 ? username : username.slice(0, at);
    const domain = at === -1 ? undefined : username.slice(at + 1);
    const masked =
        local.length <= 2
            ? `${local.slice(0, 1)}…`
            : `${local.slice(0, 2)}…${domain === undefined ? local.slice(-1) : ''}`;
    return domain === undefined ? masked : `${masked}@${domain}`;
}

/** The engine's `walletLabel`: service and masked account (`github.com · ja…@example.com`). */
export function walletLabel(origin: string, username: string): string {
    return `${new URL(origin).host.replace(/^www\./, '')} · ${maskAccount(username)}`;
}

function sameSite(a: string, b: string): boolean {
    const host = (origin: string): string => new URL(origin).host.replace(/^www\./, '');
    return new URL(a).protocol === new URL(b).protocol && host(a) === host(b);
}

const fieldKey = (label: string): string =>
    label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();

/** Changed fields replace those of the same label, an empty value removes one, the others stay. */
function mergeFields(
    existing: WalletRecord['fields'],
    changes: SaveBody['fields'],
): WalletRecord['fields'] | undefined {
    let fields = [...existing];
    for (const change of changes ?? []) {
        fields = fields.filter((field) => fieldKey(field.label) !== fieldKey(change.label));
        if (change.value !== '') fields.push({ label: change.label, uncertain: change.uncertain });
    }
    return fields.length > MAX_WALLET_FIELDS ? undefined : fields;
}

function save(
    ctx: HandlerContext,
    body: SaveBody,
    existing: WalletRecord | undefined,
): HandlerResult<{ record: WalletRecord; resolvedRequestIds: WalletRequestId[] }> {
    const { wallet } = ctx.state;
    if (wallet.state !== 'ready') return fail('wallet-not-ready');
    const fields = mergeFields(existing?.fields ?? [], body.fields);
    if (fields === undefined)
        return invalid('body.fields', `A login keeps at most ${String(MAX_WALLET_FIELDS)} fields.`);
    const record: WalletRecord = {
        id: existing?.id ?? ctx.newId(WalletRecordId, 'login'),
        label: body.label ?? existing?.label ?? walletLabel(body.origin, body.username),
        origin: body.origin,
        username: body.username,
        fields,
        updatedAt: ctx.now(),
        lastUse: existing?.lastUse ?? null,
        // New values are unverified until the engine tests them.
        verification: null,
    };
    wallet.records.set(record.id, record);
    const resolved = [...wallet.requests.values()].filter(
        (request) =>
            request.problem !== 'code' && (request.id === body.requestId || sameSite(request.origin, record.origin)),
    );
    for (const request of resolved) wallet.requests.delete(request.id);
    return ok({ record, resolvedRequestIds: resolved.map(({ id }) => id) });
}

function pendingRequest(ctx: HandlerContext, requestId: string, step: number): HandlerResult<WalletRequest> {
    const request = ctx.state.wallet.requests.get(requestId);
    if (!request) return notFound('wallet request');
    if (request.step !== step) return fail('wallet-request-moved');
    return ok(request);
}

export const WALLET_HANDLERS: Pick<
    Handlers,
    | 'getWallet'
    | 'addWalletRecord'
    | 'updateWalletRecord'
    | 'deleteWalletRecord'
    | 'markWalletRequestSeen'
    | 'rejectWalletRequest'
> = {
    getWallet: (_, ctx) => {
        const { wallet } = ctx.state;
        return ok({
            state: wallet.state,
            records: wallet.state === 'ready' ? [...wallet.records.values()] : [],
            lockedRecords: wallet.state === 'locked' ? wallet.lockedRecords : 0,
            pending: [...wallet.requests.values()].sort((a, b) => time(a.createdAt) - time(b.createdAt)),
        });
    },
    addWalletRecord: ({ body }, ctx) => {
        const username = body.username.toLowerCase();
        const existing = [...ctx.state.wallet.records.values()].find(
            (record) => sameSite(record.origin, body.origin) && record.username?.toLowerCase() === username,
        );
        return save(ctx, body, existing);
    },
    updateWalletRecord: ({ params, body }, ctx) => {
        const existing = ctx.state.wallet.records.get(params.recordId);
        if (!existing) return notFound('login');
        return save(ctx, body, existing);
    },
    deleteWalletRecord: ({ params }, ctx) => {
        if (ctx.state.wallet.state !== 'ready') return fail('wallet-not-ready');
        return ctx.state.wallet.records.delete(params.recordId) ? ok(null) : notFound('login');
    },
    markWalletRequestSeen: ({ params, body }, ctx) => {
        const found = pendingRequest(ctx, params.requestId, body.step);
        if (found.kind === 'problem' || found.data.seenAt !== null) return found;
        const seen = { ...found.data, seenAt: ctx.now() };
        ctx.state.wallet.requests.set(seen.id, seen);
        return ok(seen);
    },
    rejectWalletRequest: ({ params, body }, ctx) => {
        const found = pendingRequest(ctx, params.requestId, body.step);
        if (found.kind === 'problem') return found;
        ctx.state.wallet.requests.delete(found.data.id);
        return ok(null);
    },
};

export type NewWalletRequest = Omit<
    z.input<typeof WalletRequest>,
    'id' | 'createdAt' | 'seenAt' | 'step' | 'requests'
> &
    Partial<Pick<z.input<typeof WalletRequest>, 'step' | 'requests'>>;

/**
 * What agent work does when a login is missing or refused: one request per unresolved origin, account and problem.
 * Asking again counts on the existing request; a new problem for the same login is a new step that asks for attention
 * again.
 */
export function requestWalletLogin(ctx: EngineContext, input: NewWalletRequest): WalletRequest {
    const { requests } = ctx.state.wallet;
    const same = [...requests.values()].find(
        (request) => request.origin === input.origin && request.account === input.account,
    );
    if (same !== undefined) {
        const moved = same.problem !== input.problem;
        const updated = WalletRequest.parse({
            ...same,
            ...input,
            requests: same.requests + 1,
            step: moved ? same.step + 1 : same.step,
            seenAt: moved ? null : same.seenAt,
        });
        requests.set(updated.id, updated);
        return updated;
    }
    const request = WalletRequest.parse({
        step: 0,
        requests: 1,
        ...input,
        id: ctx.newId(WalletRequestId, 'walletreq'),
        createdAt: ctx.now(),
        seenAt: null,
    });
    requests.set(request.id, request);
    return request;
}

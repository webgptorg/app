import { z } from 'zod';

import { Timestamp } from '../common';
import { defineRoute } from '../route';
import { openEnum, toTolerant } from '../tolerant';
import { KNOWN_CAPABILITIES } from './capability';

/**
 * The engine's Wallet (its secret manager, `specs/cli/wallet.md` in the engine): login records an agent's browser
 * signs in with, and the requests agents raise when a login is missing or refused. Passwords and additional field
 * values are write-only: no route returns them, and neither do events, errors or audit entries. Setup, the 12 words for
 * recovery, import, rotation and reset stay on the engine's own owner surfaces and are not part of this contract.
 */

const WALLET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const WalletRecordId = z.string().regex(WALLET_ID_PATTERN).brand<'WalletRecordId', 'inout'>();
export type WalletRecordId = z.infer<typeof WalletRecordId>;
export const WalletRequestId = z.string().regex(WALLET_ID_PATTERN).brand<'WalletRequestId', 'inout'>();
export type WalletRequestId = z.infer<typeof WalletRequestId>;

/** The engine's limits (`mergeLoginFields`): at most this many additional fields per login. */
export const MAX_WALLET_FIELDS = 12;
export const MAX_WALLET_FIELD_LABEL_LENGTH = 80;
export const MAX_WALLET_FIELD_VALUE_LENGTH = 1000;
export const MAX_WALLET_PASSWORD_LENGTH = 4096;
export const MAX_WALLET_USERNAME_LENGTH = 320;
export const MAX_WALLET_LABEL_LENGTH = 200;
/** Bounds for one overview; an engine with more answers the first ones. */
export const MAX_WALLET_RECORDS = 1000;
export const MAX_WALLET_REQUESTS = 200;

/**
 * `ready`: unlocked and usable. `empty`: never set up. `setup`: setup started on the server and waits for its
 * confirmation. `locked`: set up, but this host cannot unlock it automatically. `unavailable`: this host cannot protect
 * the unlock key. Only `ready` accepts writes; the others are fixed on the server, never through this API.
 */
export const WALLET_STATES = ['ready', 'empty', 'setup', 'locked', 'unavailable'] as const;
export const WalletState = z.enum(WALLET_STATES);
export type WalletState = z.infer<typeof WalletState>;

/** A website's origin, `https://host[:port]` or `http://…`, as the engine normalises it: no path, query or fragment. */
export const WalletOrigin = z
    .string()
    .max(2048)
    .regex(/^https?:\/\/[^\s/?#@]+$/)
    .refine((value) => URL.canParse(value) && new URL(value).origin === value, 'Not a normalised origin.');

const FieldLabel = z.string().trim().min(1).max(MAX_WALLET_FIELD_LABEL_LENGTH);

/** An additional login field as the engine reports it: its label only, the value stays encrypted. */
export const WalletFieldInfo = z.strictObject({
    label: FieldLabel,
    /** Kept although the engine does not know whether later logins need it. */
    uncertain: z.boolean(),
});

/** The latest explicit credential test; `null` on the record means it was never tested (unverified). */
export const WALLET_VERIFICATION_STATES = ['verified', 'rejected', 'incomplete'] as const;
export const WalletVerification = z.strictObject({
    state: z.enum(WALLET_VERIFICATION_STATES),
    at: Timestamp,
    /** A short, nonsecret reason, e.g. why a test could not finish. */
    reason: z.string().max(500),
});

export const WALLET_SIGN_IN_OUTCOMES = ['signed-in', 'rejected'] as const;

/** One saved login without its secrets. */
export const WalletRecord = z.strictObject({
    id: WalletRecordId,
    /** Editable; the engine derives it from service and masked account (`github.com · ja…@example.com`). */
    label: z.string().min(1).max(MAX_WALLET_LABEL_LENGTH),
    origin: WalletOrigin,
    /**
     * Intentionally nonsecret account metadata the engine already shares with agents; `null` when the engine does not
     * report it.
     */
    username: z.string().min(1).max(MAX_WALLET_USERNAME_LENGTH).nullable(),
    fields: z.array(WalletFieldInfo).max(MAX_WALLET_FIELDS),
    updatedAt: Timestamp,
    /** The last automatic sign-in with it: historical evidence, not a guarantee that a session is still valid. */
    lastUse: z.strictObject({ at: Timestamp, outcome: z.enum(WALLET_SIGN_IN_OUTCOMES) }).nullable(),
    verification: WalletVerification.nullable(),
});
export type WalletRecord = z.infer<typeof WalletRecord>;

/**
 * Why work waits: `missing` (no saved login), `rejected` (the website refused the saved one), `locked` (the Wallet must
 * be unlocked on the server), `code` (a one-time code only the owner has; entered on the server, never stored) or
 * `field` (the website asks for additional fields the saved login lacks).
 */
export const WALLET_REQUEST_PROBLEMS = ['missing', 'rejected', 'locked', 'code', 'field'] as const;

/** A pending agent request for a login: one per unresolved service, account and step, however often work asked. */
export const WalletRequest = z.strictObject({
    id: WalletRequestId,
    origin: WalletOrigin,
    /** The account the work needs, when the work named one. */
    account: z.string().min(1).max(MAX_WALLET_USERNAME_LENGTH).nullable(),
    problem: z.enum(WALLET_REQUEST_PROBLEMS),
    /** For `field`: the labels the website asks for. */
    fields: z.array(FieldLabel).max(MAX_WALLET_FIELDS),
    /** For `rejected` and `field`: the saved login this request is about. */
    recordId: WalletRecordId.nullable(),
    /** The engine's nonsecret explanation. */
    reason: z.string().max(1000),
    /** Names of the tasks waiting for it. */
    tasks: z.array(z.string().min(1).max(256)).max(50),
    /** Names of the agents whose work asked, the responsible one first; empty for system work (Fixer is responsible). */
    agents: z.array(z.string().min(1).max(256)).max(50),
    /** How often work asked, deduplicated into this one request. */
    requests: z.int().min(1),
    createdAt: Timestamp,
    /** Set by Mark as seen: the request keeps waiting but no longer asks for attention. */
    seenAt: Timestamp.nullable(),
    /** The current human step. A new step asks for attention again; seen and reject name the step they answer. */
    step: z.int().min(0),
});
export type WalletRequest = z.infer<typeof WalletRequest>;

export const WalletOverview = z.strictObject({
    state: WalletState,
    /** Empty unless `ready`. */
    records: z.array(WalletRecord).max(MAX_WALLET_RECORDS),
    /** Saved logins that stay encrypted while the Wallet is locked (their labels are encrypted too). */
    lockedRecords: z.int().min(0),
    /** Oldest first. */
    pending: z.array(WalletRequest).max(MAX_WALLET_REQUESTS),
});
export type WalletOverview = z.infer<typeof WalletOverview>;

/**
 * Newer engines' states, problems and outcomes read as `unknown` instead of failing the whole Wallet page; engines
 * still answer with the closed enums.
 */
const ReadWalletRecord = WalletRecord.extend({
    lastUse: z.strictObject({ at: Timestamp, outcome: openEnum(WALLET_SIGN_IN_OUTCOMES) }).nullable(),
    verification: WalletVerification.extend({ state: openEnum(WALLET_VERIFICATION_STATES) }).nullable(),
});
const ReadWalletOverviewShape = WalletOverview.extend({
    state: openEnum(WALLET_STATES),
    records: z.array(ReadWalletRecord).max(MAX_WALLET_RECORDS),
    pending: z.array(WalletRequest.extend({ problem: openEnum(WALLET_REQUEST_PROBLEMS) })).max(MAX_WALLET_REQUESTS),
});
const ReadWalletOverview = toTolerant(ReadWalletOverviewShape);
export type ReadWalletOverview = z.output<typeof ReadWalletOverviewShape>;
export type ReadWalletRecord = ReadWalletOverview['records'][number];
export type ReadWalletRequest = ReadWalletOverview['pending'][number];
const ReadWalletRequestSchema = toTolerant(WalletRequest.extend({ problem: openEnum(WALLET_REQUEST_PROBLEMS) }));

/** Write-only: accepted in requests, never part of any response. */
export const WalletPassword = z.string().min(1).max(MAX_WALLET_PASSWORD_LENGTH);

/** An additional field to set; an empty `value` removes the field of that label. The value is write-only. */
export const WalletFieldInput = z.strictObject({
    label: FieldLabel,
    value: z.string().max(MAX_WALLET_FIELD_VALUE_LENGTH),
    uncertain: z.boolean().default(false),
});

const saveShape = {
    origin: WalletOrigin,
    username: z.string().trim().min(1).max(MAX_WALLET_USERNAME_LENGTH),
    password: WalletPassword,
    /** Omitted: a new login gets the engine's derived label, an updated one keeps its label. */
    label: z.string().trim().min(1).max(MAX_WALLET_LABEL_LENGTH).optional(),
    /** Changes only the fields named; the others stay. */
    fields: z.array(WalletFieldInput).max(MAX_WALLET_FIELDS).optional(),
    /** The pending request this answers, so its work resumes even if the origin differs slightly. */
    requestId: WalletRequestId.optional(),
};
export const AddWalletRecordBody = z.strictObject(saveShape);
export const UpdateWalletRecordBody = z.strictObject(saveShape);

export const WalletSaved = z.strictObject({
    record: WalletRecord,
    /** Pending requests the save resolved (their work resumes); a `code` request is never resolved by a save. */
    resolvedRequestIds: z.array(WalletRequestId).max(MAX_WALLET_REQUESTS),
});
const ReadWalletSaved = toTolerant(WalletSaved.extend({ record: ReadWalletRecord }));

export const WalletRecordParams = z.strictObject({ recordId: WalletRecordId });
export const WalletRequestParams = z.strictObject({ requestId: WalletRequestId });
/** The step the member saw, so a stale page cannot answer a later step. */
export const WalletRequestStepBody = z.strictObject({ step: z.int().min(0) });

const capability = KNOWN_CAPABILITIES.wallet;

export const WALLET_ROUTES = {
    getWallet: defineRoute({
        id: 'getWallet',
        method: 'GET',
        path: '/wallet',
        summary: "The Wallet's state, saved logins without secrets and pending agent requests",
        permission: 'wallet.read',
        capability,
        responses: { 200: { kind: 'json', schema: WalletOverview, read: ReadWalletOverview } },
    }),
    addWalletRecord: defineRoute({
        id: 'addWalletRecord',
        method: 'POST',
        path: '/wallet/records',
        summary: 'Save a login; its password and field values can never be read back',
        description:
            'A login for the same origin and username is updated rather than duplicated. The save resolves the ' +
            'pending requests for that origin (and `requestId`), except one-time code requests. A new or changed ' +
            'login stays unverified until the engine tests it. 409 `wallet-not-ready` unless the Wallet is `ready`.',
        permission: 'wallet.manage',
        capability,
        body: { kind: 'json', schema: AddWalletRecordBody },
        responses: { 200: { kind: 'json', schema: WalletSaved, read: ReadWalletSaved } },
        problems: ['wallet-not-ready'],
        stepUp: true,
    }),
    updateWalletRecord: defineRoute({
        id: 'updateWalletRecord',
        method: 'PUT',
        path: '/wallet/records/{recordId}',
        summary: 'Replace one login’s username and password, and change its label or fields',
        permission: 'wallet.manage',
        capability,
        params: WalletRecordParams,
        body: { kind: 'json', schema: UpdateWalletRecordBody },
        responses: { 200: { kind: 'json', schema: WalletSaved, read: ReadWalletSaved } },
        problems: ['wallet-not-ready'],
        stepUp: true,
    }),
    deleteWalletRecord: defineRoute({
        id: 'deleteWalletRecord',
        method: 'DELETE',
        path: '/wallet/records/{recordId}',
        summary: 'Remove one saved login; other logins are untouched',
        permission: 'wallet.manage',
        capability,
        params: WalletRecordParams,
        responses: { 204: { kind: 'empty' } },
        problems: ['wallet-not-ready'],
        stepUp: true,
    }),
    markWalletRequestSeen: defineRoute({
        id: 'markWalletRequestSeen',
        method: 'POST',
        path: '/wallet/requests/{requestId}/seen',
        summary: 'Mark as seen: the request keeps waiting, but stops asking for attention in every client',
        description:
            'Neither an answer nor a refusal. Idempotent for the same step; 409 `wallet-request-moved` when the ' +
            'request moved to another step since it was shown, 404 once it is no longer pending.',
        permission: 'wallet.manage',
        capability,
        params: WalletRequestParams,
        body: { kind: 'json', schema: WalletRequestStepBody },
        responses: { 200: { kind: 'json', schema: WalletRequest, read: ReadWalletRequestSchema } },
        problems: ['wallet-request-moved'],
    }),
    rejectWalletRequest: defineRoute({
        id: 'rejectWalletRequest',
        method: 'POST',
        path: '/wallet/requests/{requestId}/reject',
        summary: 'Reject request: end it; the waiting work learns that nothing was provided',
        description:
            'The work is never told it signed in, and the same request is not raised again for it. 409 ' +
            '`wallet-request-moved` for a stale step, 404 once it is no longer pending.',
        permission: 'wallet.manage',
        capability,
        params: WalletRequestParams,
        body: { kind: 'json', schema: WalletRequestStepBody },
        responses: { 204: { kind: 'empty' } },
        problems: ['wallet-request-moved'],
    }),
} as const;

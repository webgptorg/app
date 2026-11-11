import { z } from 'zod';

/**
 * What the operator's commands (`status`, `connect`, and later `setup-link` and `owner --reset`) ask the running
 * engine. It is served only on the operator channel, a Unix socket inside `PTBK_DATA_DIR`: shell access to the host is
 * the trust level these need, so there is no API or UI route to any of them.
 */
export interface OperatorApi {
    status(): OperatorStatus;
    /**
     * Picks up a registration that `connect` just stored, and brings an unlinked engine online. With
     * `callerShowsSetupLink` the command shows the first setup link, and the engine does not issue one of its own:
     * each issue replaces the previous secret, so two would invalidate each other's link.
     */
    link(options: LinkOptions): Promise<LinkAnswer>;
    /**
     * A fresh setup link, replacing the previous one, once the address works and while there is no owner. The answer
     * carries the secret: it goes to the operator's terminal and nowhere else.
     */
    setupLink(): Promise<SetupLinkAnswer>;
    /** Revokes every passkey and session; data stays. */
    resetOwner(): Promise<ResetAnswer>;
}

export interface LinkOptions {
    readonly callerShowsSetupLink: boolean;
}

/** `POST /v1/link?setup-link=caller`: the caller shows the first setup link. */
export const LINK_QUERY = z.strictObject({ 'setup-link': z.literal('caller').optional() });

const Hostname = z.string().min(1).max(253);
const Iso = z.iso.datetime({ offset: false });

export const RelayState = z.enum(['connected', 'connecting', 'disconnected']);
const AddressGapSchema = z.enum(['relay', 'certificate', 'setup-page']);

export const OperatorStatus = z.strictObject({
    engineId: z.string().min(1).max(64),
    hostname: Hostname,
    fingerprint: z.string().max(32),
    version: z.string().max(64),
    /** `local` until the engine is linked; it then dials the relays. */
    mode: z.enum(['tunnel', 'local']),
    dashboardUrl: z.url().max(2048).nullable(),
    relays: z.array(z.strictObject({ relay: Hostname, state: RelayState })).max(64),
    certificate: z.strictObject({ notAfter: Iso }).nullable(),
    ui: z.strictObject({ version: z.string().max(64) }).nullable(),
    updatePolicy: z.enum(['auto', 'manual', 'pinned']),
    ownerSetUp: z.boolean(),
    heartbeat: z
        .strictObject({
            sentAt: Iso,
            answer: z.enum(['accepted', 'refused', 'unavailable']).nullable(),
            status: z.int().min(100).max(599).nullable(),
            clockSkewS: z.int().nullable(),
        })
        .nullable(),
    /** What the address still lacks; empty once a browser can reach the engine. */
    addressGaps: z.array(AddressGapSchema).max(3),
});
export type OperatorStatus = z.infer<typeof OperatorStatus>;

export const LinkAnswer = z.discriminatedUnion('outcome', [
    z.strictObject({ outcome: z.literal('linked'), relays: z.int().min(0).max(64) }),
    z.strictObject({ outcome: z.literal('already-linked') }),
    /** No `registration.json` (yet), or one this engine refuses: nothing changed. */
    z.strictObject({ outcome: z.literal('not-registered') }),
]);
export type LinkAnswer = z.infer<typeof LinkAnswer>;

export const SetupLinkAnswer = z.discriminatedUnion('outcome', [
    z.strictObject({
        outcome: z.literal('created'),
        url: z.url({ protocol: /^https$/ }).max(512),
        expiresAt: Iso,
    }),
    z.strictObject({ outcome: z.literal('owner-exists') }),
    z.strictObject({ outcome: z.literal('not-ready'), missing: z.array(AddressGapSchema).min(1).max(3) }),
]);
export type SetupLinkAnswer = z.infer<typeof SetupLinkAnswer>;

export const ResetAnswer = z.strictObject({ passkeys: z.int().min(0), sessions: z.int().min(0) });
export type ResetAnswer = z.infer<typeof ResetAnswer>;

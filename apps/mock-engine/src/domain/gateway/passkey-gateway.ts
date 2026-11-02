import type { ClientInfo, Member } from '@ptbk/engine-api';
import type { Actor, InMemoryEngineController } from '@ptbk/engine-api/in-memory';
import { encodeBase64Url } from '@ptbk/protocol';

import type { Clock } from '../clock';
import type { Logger } from '../logger';
import type { SetupSecrets } from '../onboarding/setup-secret';
import type { Random } from '../random';
import type { Challenges, PasskeyCeremonies, PasskeyCredential, RelyingParty } from './passkey-ceremonies';
import type { SessionStore } from './sessions';

/** What the engine keeps of a registered passkey: the credential's public half and whom it signs in. */
export interface StoredPasskey extends PasskeyCredential {
    /** The engine API's ID for it (`GET /passkeys`), separate from the credential ID the browser sends. */
    readonly passkeyId: string;
    readonly memberId: string;
    readonly name: string;
    readonly createdAt: string;
    /** The member it belongs to, so a restart, which forgets the mock's in-memory state, can restore the owner. */
    readonly member: { readonly displayName: string; readonly role: Member['role']; readonly createdAt: string };
}

/** The passkeys the gateway can verify; the engine API's list is the authority on which are still valid. */
export interface PasskeyStore {
    list(): Promise<readonly StoredPasskey[]>;
    add(passkey: StoredPasskey): Promise<void>;
    /** After an assertion: the signature counter and backup state it reported. */
    update(credentialId: string, use: { readonly counter: number; readonly backedUp: boolean }): Promise<void>;
    clear(): Promise<void>;
}

/** For engines whose passkeys need not survive a restart (tests); the engine itself keeps them in `PTBK_DATA_DIR`. */
export function createInMemoryPasskeyStore(initial: readonly StoredPasskey[] = []): PasskeyStore {
    let passkeys = [...initial];
    return {
        list: () => Promise.resolve([...passkeys]),
        add(passkey) {
            if (passkeys.some(({ credentialId }) => credentialId === passkey.credentialId)) {
                return Promise.reject(new Error('a passkey with this credential ID is already registered'));
            }
            passkeys = [...passkeys, passkey];
            return Promise.resolve();
        },
        update(credentialId, use) {
            passkeys = passkeys.map((passkey) =>
                passkey.credentialId === credentialId ? { ...passkey, ...use } : passkey,
            );
            return Promise.resolve();
        },
        clear() {
            passkeys = [];
            return Promise.resolve();
        },
    };
}

export type GatewayEngine = Pick<
    InMemoryEngineController,
    'inspect' | 'addMember' | 'addPasskey' | 'removePasskey' | 'removeSession' | 'recordAudit' | 'recordPasskeyUse'
>;

export type SetupOptionsOutcome =
    | { readonly kind: 'options'; readonly options: unknown }
    | { readonly kind: 'invalid' }
    | { readonly kind: 'owner-exists' };

export type SetupOutcome =
    | { readonly kind: 'owner'; readonly token: string }
    | { readonly kind: 'invalid' }
    | { readonly kind: 'owner-exists' }
    | { readonly kind: 'not-verified' };

export type AssertionOutcome =
    { readonly kind: 'verified'; readonly token: string } | { readonly kind: 'not-recognised' };

export interface PasskeyGateway {
    setupOptions(input: { readonly secret: string; readonly rp: RelyingParty }): Promise<SetupOptionsOutcome>;
    /** Registers the owner's first passkey and signs them in; the setup secret is spent only if the passkey verifies. */
    completeSetup(input: {
        readonly secret: string;
        readonly response: unknown;
        readonly rp: RelyingParty;
        readonly client: ClientInfo;
    }): Promise<SetupOutcome>;
    signInOptions(rp: RelyingParty): Promise<unknown>;
    signIn(input: {
        readonly response: unknown;
        readonly rp: RelyingParty;
        readonly client: ClientInfo;
    }): Promise<AssertionOutcome>;
    stepUpOptions(input: { readonly actor: Actor; readonly rp: RelyingParty }): Promise<unknown>;
    stepUp(input: { readonly actor: Actor; readonly response: unknown; readonly rp: RelyingParty }): Promise<boolean>;
    /** `owner --reset`: every passkey and session ends, data stays, and the setup link works again. */
    resetOwner(): Promise<{ readonly passkeys: number; readonly sessions: number }>;
    /** Puts the stored passkeys back into a fresh engine state (at start, after `/__mock/reset`). */
    restore(): Promise<void>;
}

export interface PasskeyGatewayDeps {
    readonly engine: () => GatewayEngine;
    readonly sessions: SessionStore;
    readonly secrets: SetupSecrets;
    readonly passkeys: PasskeyStore;
    readonly ceremonies: PasskeyCeremonies;
    readonly challenges: Challenges;
    readonly random: Random;
    readonly clock: Clock;
    readonly logger: Logger;
    /** Called after the owner was set up or reset. */
    readonly onOwnerChanged?: () => void;
}

const RP_NAME = 'Promptbook engine';
const ID_BYTES = 12;

/** The name the owner sees in the passkey list; they tell devices apart by its kind and date. */
export function passkeyName(credential: PasskeyCredential): string {
    switch (credential.attachment) {
        case 'platform':
            return 'Built-in passkey';
        case 'cross-platform':
            return 'Security key or phone';
        case null:
            return 'Passkey';
    }
}

function iso(ms: number): string {
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * The gateway's passkey side, on the setup secret, the WebAuthn port and the engine's state. The engine API's list of
 * passkeys and members decides who may sign in: a passkey revoked there, or a member removed, stops at once, even
 * though the stored credential is only dropped by `owner --reset`.
 */
export function createPasskeyGateway(deps: PasskeyGatewayDeps): PasskeyGateway {
    const { logger } = deps;
    const newId = (prefix: string): string => `${prefix}-${encodeBase64Url(deps.random.bytes(ID_BYTES))}`;

    /** The member setup makes the owner: the existing owner (after `owner --reset`, or a seed without passkeys). */
    function ownerToBe(): Member | undefined {
        return deps
            .engine()
            .inspect()
            .members.find((member) => member.role === 'owner' && member.status === 'active');
    }

    /** A stored passkey that still signs its member in, by the engine's own lists. */
    async function usable(credentialId: string): Promise<StoredPasskey | undefined> {
        const stored = (await deps.passkeys.list()).find((passkey) => passkey.credentialId === credentialId);
        if (stored === undefined) return undefined;
        const snapshot = deps.engine().inspect();
        const listed = snapshot.passkeys.some(
            ({ id, memberId }) => id === stored.passkeyId && memberId === stored.memberId,
        );
        const member = snapshot.members.find(({ id }) => id === stored.memberId);
        return listed && member?.status === 'active' ? stored : undefined;
    }

    function audit(
        action: 'passkey.register' | 'auth.sign-in' | 'auth.step-up',
        memberId: string,
        passkey: StoredPasskey,
        client: ClientInfo,
    ): void {
        deps.engine().recordAudit({
            actor: { kind: 'member', memberId },
            action,
            target: { kind: 'passkey', id: passkey.passkeyId, name: passkey.name },
            outcome: 'success',
            client,
        });
    }

    async function verifiedAssertion(
        response: unknown,
        rp: RelyingParty,
        expectChallenge: (challenge: string) => boolean,
        memberId: string | null,
    ): Promise<StoredPasskey | null> {
        const credentialId = deps.ceremonies.credentialIdOf(response);
        if (credentialId === null) return null;
        const stored = await usable(credentialId);
        if (stored === undefined || (memberId !== null && stored.memberId !== memberId)) return null;
        const verified = await deps.ceremonies.verifyAuthentication({
            rp,
            response,
            credential: stored,
            expectChallenge,
        });
        if (verified === null) return null;
        await deps.passkeys.update(stored.credentialId, verified);
        deps.engine().recordPasskeyUse(stored.passkeyId, { at: iso(deps.clock.nowMs()), backedUp: verified.backedUp });
        return stored;
    }

    async function restore(): Promise<void> {
        const engine = deps.engine();
        for (const passkey of await deps.passkeys.list()) {
            const snapshot = engine.inspect();
            if (!snapshot.members.some(({ id }) => id === passkey.memberId)) {
                engine.addMember({ id: passkey.memberId, status: 'active', lastSeenAt: null, ...passkey.member });
            }
            if (snapshot.passkeys.some(({ id }) => id === passkey.passkeyId)) continue;
            engine.addPasskey({
                id: passkey.passkeyId,
                memberId: passkey.memberId,
                name: passkey.name,
                createdAt: passkey.createdAt,
                lastUsedAt: null,
                authenticator: { attachment: passkey.attachment, backedUp: passkey.backedUp },
            });
        }
    }

    return {
        async setupOptions({ secret, rp }) {
            const check = await deps.secrets.check(secret);
            if (check !== 'valid') return { kind: check };
            const owner = ownerToBe();
            const options = await deps.ceremonies.registrationOptions({
                rp,
                rpName: RP_NAME,
                userHandle: encodeBase64Url(deps.random.bytes(ID_BYTES)),
                userName: owner?.displayName ?? 'Owner',
                challenge: deps.challenges.issue('setup'),
                excludeCredentialIds: [],
            });
            return { kind: 'options', options };
        },

        async completeSetup({ secret, response, rp, client }) {
            // A cheap refusal first, before any signature work for a link that cannot succeed.
            const check = await deps.secrets.check(secret);
            if (check !== 'valid') return { kind: check };
            const credential = await deps.ceremonies.verifyRegistration({
                rp,
                response,
                expectChallenge: (challenge) => deps.challenges.take(challenge, 'setup'),
            });
            if (credential === null) return { kind: 'not-verified' };
            // Spent here, after the passkey verified: of two browsers racing with one link, only one becomes owner.
            const spent = await deps.secrets.consume(secret);
            if (spent !== 'valid') return { kind: spent };
            const engine = deps.engine();
            const nowMs = deps.clock.nowMs();
            const existing = ownerToBe();
            const member =
                existing ??
                engine.addMember({
                    id: newId('member'),
                    displayName: 'Owner',
                    role: 'owner',
                    status: 'active',
                    createdAt: iso(nowMs),
                    lastSeenAt: null,
                });
            const passkey: StoredPasskey = {
                ...credential,
                passkeyId: newId('passkey'),
                memberId: member.id,
                name: passkeyName(credential),
                createdAt: iso(nowMs),
                member: { displayName: member.displayName, role: member.role, createdAt: member.createdAt },
            };
            await deps.passkeys.add(passkey);
            engine.addPasskey({
                id: passkey.passkeyId,
                memberId: member.id,
                name: passkey.name,
                createdAt: passkey.createdAt,
                lastUsedAt: passkey.createdAt,
                authenticator: { attachment: passkey.attachment, backedUp: passkey.backedUp },
            });
            audit('passkey.register', member.id, passkey, client);
            const { token } = deps.sessions.signIn({
                memberId: member.id,
                permissions: null,
                client,
                passkeyId: passkey.passkeyId,
            });
            audit('auth.sign-in', member.id, passkey, client);
            logger.info('owner.passkey-registered', {});
            deps.onOwnerChanged?.();
            return { kind: 'owner', token };
        },

        signInOptions(rp) {
            return deps.ceremonies.authenticationOptions({
                rp,
                challenge: deps.challenges.issue('sign-in'),
                allowCredentialIds: null,
            });
        },

        async signIn({ response, rp, client }) {
            const passkey = await verifiedAssertion(
                response,
                rp,
                (challenge) => deps.challenges.take(challenge, 'sign-in'),
                null,
            );
            if (passkey === null) return { kind: 'not-recognised' };
            const { token } = deps.sessions.signIn({
                memberId: passkey.memberId,
                permissions: null,
                client,
                passkeyId: passkey.passkeyId,
            });
            audit('auth.sign-in', passkey.memberId, passkey, client);
            return { kind: 'verified', token };
        },

        async stepUpOptions({ actor, rp }) {
            const own = (await deps.passkeys.list()).filter(({ memberId }) => memberId === actor.memberId);
            return deps.ceremonies.authenticationOptions({
                rp,
                challenge: deps.challenges.issue('step-up', actor.sessionId),
                allowCredentialIds: own.map(({ credentialId }) => credentialId),
            });
        },

        async stepUp({ actor, response, rp }) {
            const passkey = await verifiedAssertion(
                response,
                rp,
                (challenge) => deps.challenges.take(challenge, 'step-up', actor.sessionId),
                actor.memberId,
            );
            if (passkey === null) return false;
            deps.sessions.confirmStepUp(actor.sessionId);
            audit('auth.step-up', actor.memberId, passkey, actor.client);
            return true;
        },

        async resetOwner() {
            const engine = deps.engine();
            const snapshot = engine.inspect();
            for (const { id } of snapshot.passkeys) engine.removePasskey(id);
            const sessions = engine.inspect().sessions;
            for (const { id } of sessions) engine.removeSession(id);
            deps.sessions.clear();
            await deps.passkeys.clear();
            await deps.secrets.revoke();
            const counts = { passkeys: snapshot.passkeys.length, sessions: snapshot.sessions.length };
            for (const [action, count] of [
                ['passkey.revoke', counts.passkeys],
                ['session.revoke', counts.sessions],
            ] as const) {
                engine.recordAudit({
                    actor: { kind: 'system' },
                    action,
                    target: null,
                    outcome: 'success',
                    client: null,
                    details: { count, via: 'owner --reset' },
                });
            }
            logger.warn('owner.reset', counts);
            deps.onOwnerChanged?.();
            return counts;
        },

        restore,
    };
}

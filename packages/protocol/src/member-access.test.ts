import { describe, expect, it } from 'vitest';

import { decodeBase64Url, encodeBase64Url } from './base64url';
import { utf8Encode } from './bytes';
import { createWebCryptoSigner, generateEd25519KeyPair, importEd25519PrivateKey } from './ed25519';
import { EngineId, Timestamp } from './ids';
import type { AccessTicket, MemberRevocation } from './member-access';
import {
    SIGNED_MEMBER_MESSAGE_MAX_LENGTH,
    signAccessTicket,
    signMemberRevocation,
    verifyAccessTicket,
    verifyMemberRevocation,
} from './member-access';
import vectors from './member-access-vectors.json';
import { SIGNING_CONTEXT, signingInput } from './signing-input';
import type { SigningContext } from './signing-input';
import { fromHex, toHex } from './testing/hex';

const memberKey = fromHex(vectors.memberKey.publicKeyHex);
const engineId = EngineId.parse(vectors.accessTicket.body.engineId);
const ticket = vectors.accessTicket.body as AccessTicket;
const revocation = vectors.memberRevocation.body as MemberRevocation;
const at = (iso: string) => Timestamp.parse(iso);

async function vectorSigner() {
    return createWebCryptoSigner(
        await importEd25519PrivateKey(fromHex(vectors.memberKey.seedHex), { extractable: false }),
    );
}

async function otherSigner() {
    return createWebCryptoSigner(await generateEd25519KeyPair({ extractable: false }));
}

const verifyTicket = (token: string, now = '2026-10-30T12:05:00Z', engine: EngineId = engineId) =>
    verifyAccessTicket({ token, memberKey, engineId: engine, now: at(now) });

/** A token over arbitrary body bytes, signed correctly, so only the body's content can be wrong. */
async function signedBody(body: string, context: SigningContext = SIGNING_CONTEXT.accessTicket): Promise<string> {
    const bytes = utf8Encode(body);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const signature = await (await vectorSigner()).sign(signingInput(context, digest));
    return `${encodeBase64Url(bytes)}.${encodeBase64Url(signature)}`;
}

describe('member access golden vectors (src/member-access-vectors.json)', () => {
    it('signs the ticket and the revocation exactly as computed outside this package', async () => {
        const signer = await vectorSigner();
        expect(toHex(signer.publicKey())).toBe(vectors.memberKey.publicKeyHex);
        expect(await signAccessTicket(signer, ticket)).toBe(vectors.accessTicket.token);
        expect(await signMemberRevocation(signer, revocation)).toBe(vectors.memberRevocation.token);
    });

    it('signs over the documented signing input', async () => {
        const body = utf8Encode(vectors.accessTicket.bodyUtf8);
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
        expect(toHex(signingInput(SIGNING_CONTEXT.accessTicket, digest))).toBe(vectors.accessTicket.signingInputHex);
    });

    it('verifies both vectors', async () => {
        expect(await verifyTicket(vectors.accessTicket.token)).toEqual({ kind: 'accepted', ticket });
        expect(await verifyMemberRevocation({ token: vectors.memberRevocation.token, memberKey, engineId })).toEqual({
            kind: 'accepted',
            revocation,
        });
    });
});

describe('verifyAccessTicket', () => {
    it('refuses a ticket signed by another key', async () => {
        const forged = await signAccessTicket(await otherSigner(), ticket);
        expect(await verifyTicket(forged)).toEqual({ kind: 'bad-signature' });
    });

    it('refuses a ticket whose body changed after signing', async () => {
        const [, signature] = vectors.accessTicket.token.split('.');
        const changed = encodeBase64Url(utf8Encode(JSON.stringify({ ...ticket, proposedRole: 'admin' })));
        expect(await verifyTicket(`${changed}.${signature ?? ''}`)).toEqual({ kind: 'bad-signature' });
    });

    it('refuses a revocation presented as a ticket: the purposes never verify for each other', async () => {
        expect(await verifyTicket(vectors.memberRevocation.token)).toEqual({ kind: 'bad-signature' });
        expect(await verifyMemberRevocation({ token: vectors.accessTicket.token, memberKey, engineId })).toEqual({
            kind: 'bad-signature',
        });
    });

    it.each([
        ['empty', ''],
        ['no dot', 'abc'],
        ['three parts', 'a.b.c'],
        ['not base64url', '!!!.???'],
        ['a short signature', `${encodeBase64Url(utf8Encode('{}'))}.${encodeBase64Url(new Uint8Array(63))}`],
        ['too long', 'a'.repeat(SIGNED_MEMBER_MESSAGE_MAX_LENGTH + 1)],
    ])('refuses a malformed token: %s', async (_, token) => {
        expect(await verifyTicket(token)).toEqual({ kind: 'malformed' });
    });

    it('refuses a signed body that is not UTF-8 JSON', async () => {
        expect(await verifyTicket(await signedBody('not json'))).toEqual({ kind: 'malformed' });
    });

    it.each([
        ['an unknown field', { ...ticket, plan: 'pro' }],
        ['another version', { ...ticket, v: 2 }],
        ['an owner role proposed', { ...ticket, proposedRole: 'owner' }],
        ['a lifetime over 15 minutes', { ...ticket, expiresAt: '2026-10-30T12:15:01Z' }],
        ['an expiry before issue', { ...ticket, expiresAt: '2026-10-30T11:59:00Z' }],
        ['a ticket ID too short to be random', { ...ticket, ticketId: 'short' }],
        ['no ticket ID, so nothing to spend', { ...ticket, ticketId: undefined }],
        ['a display name over 128 characters', { ...ticket, displayName: 'x'.repeat(129) }],
        ['an email over 254 characters', { ...ticket, email: `${'x'.repeat(250)}@x.cz` }],
        ['a dashboard user ID outside its alphabet', { ...ticket, dashboardUserId: 'user/../owner' }],
        ['an expiry that is not a timestamp', { ...ticket, expiresAt: 'tomorrow' }],
        ['null for a body', null],
        ['an array for a body', [ticket]],
    ])('refuses a signed body with %s', async (_, body) => {
        expect(await verifyTicket(await signedBody(JSON.stringify(body)))).toEqual({ kind: 'invalid-body' });
    });

    it('refuses a ticket signed under another purpose’s context', async () => {
        const underHeartbeat = await signedBody(vectors.accessTicket.bodyUtf8, SIGNING_CONTEXT.heartbeat);
        expect(await verifyTicket(underHeartbeat)).toEqual({ kind: 'bad-signature' });
    });

    it('refuses a ticket for another engine', async () => {
        expect(await verifyTicket(vectors.accessTicket.token, undefined, EngineId.parse('a'.repeat(26)))).toEqual({
            kind: 'engine-mismatch',
        });
    });

    it('accepts within its lifetime and two minutes of skew, and refuses outside', async () => {
        const token = vectors.accessTicket.token;
        expect((await verifyTicket(token, '2026-10-30T11:58:00Z')).kind).toBe('accepted');
        expect(await verifyTicket(token, '2026-10-30T11:57:59Z')).toEqual({ kind: 'not-yet-valid' });
        expect((await verifyTicket(token, '2026-10-30T12:14:59Z')).kind).toBe('accepted');
        expect(await verifyTicket(token, '2026-10-30T12:15:00Z')).toEqual({ kind: 'expired' });
    });

    it('throws when asked to sign a ticket outside the schema', async () => {
        await expect(signAccessTicket(await vectorSigner(), { ...ticket, email: '' })).rejects.toThrow();
    });
});

describe('verifyMemberRevocation', () => {
    const verify = (token: string, engine: EngineId = engineId) =>
        verifyMemberRevocation({ token, memberKey, engineId: engine });

    it('refuses a forged, malformed, invalid or misdirected revocation', async () => {
        expect(await verify(await signMemberRevocation(await otherSigner(), revocation))).toEqual({
            kind: 'bad-signature',
        });
        expect(await verify('x.y.z')).toEqual({ kind: 'malformed' });
        const extra = await signedBody(
            JSON.stringify({ ...revocation, reason: 'x' }),
            SIGNING_CONTEXT.memberRevocation,
        );
        expect(await verify(extra)).toEqual({ kind: 'invalid-body' });
        expect(await verify(vectors.memberRevocation.token, EngineId.parse('b'.repeat(26)))).toEqual({
            kind: 'engine-mismatch',
        });
    });

    it.each([
        ['another version', { ...revocation, v: 2 }],
        ['no dashboard user', { ...revocation, dashboardUserId: undefined }],
        ['a revocation ID too short to be random', { ...revocation, revocationId: 'short' }],
        ['a member ID in place of a dashboard user', { ...revocation, dashboardUserId: 'member owner' }],
    ])('refuses a signed revocation with %s', async (_, body) => {
        const token = await signedBody(JSON.stringify(body), SIGNING_CONTEXT.memberRevocation);
        expect(await verify(token)).toEqual({ kind: 'invalid-body' });
    });

    it('refuses a signed revocation that is not JSON, and one over the size cap', async () => {
        expect(await verify(await signedBody('{', SIGNING_CONTEXT.memberRevocation))).toEqual({ kind: 'malformed' });
        expect(await verify('a'.repeat(SIGNED_MEMBER_MESSAGE_MAX_LENGTH + 1))).toEqual({ kind: 'malformed' });
    });

    it('keeps a token within the reply cap for the longest IDs', async () => {
        const longest = await signMemberRevocation(await vectorSigner(), {
            ...revocation,
            revocationId: 'r'.repeat(64),
            dashboardUserId: 'u'.repeat(64),
        });
        expect(longest.length).toBeLessThan(SIGNED_MEMBER_MESSAGE_MAX_LENGTH);
        const [body] = longest.split('.');
        expect(decodeBase64Url(body ?? '').kind).toBe('ok');
    });
});

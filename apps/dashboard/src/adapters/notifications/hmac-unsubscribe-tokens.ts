import { fromBase64Url, toBase64Url } from '../../domain/auth/secrets';
import { orgIdSchema, userIdSchema } from '../../domain/ids';
import type { UnsubscribeClaims, UnsubscribeTokens } from '../../domain/notifications/unsubscribe-tokens';
import { notificationKindSchema } from '../../shared/notifications/registry';

/** Domain separation: this key and MAC sign unsubscribe tokens only. */
const HKDF_INFO = 'ptbk-notification-unsubscribe-v1';
const MAC_CONTEXT = 'ptbk-unsubscribe-v1|';
const VERSION = 'u1';

// u1.<userId>.<orgId>.<kind>~<kind>.<HMAC-SHA-256, base64url>: IDs are base32 and kinds lowercase words, so the parts
// never contain a separator, and every character is URL-unreserved: a query string carries the token unchanged (a `+`
// would read as a space there).
const TOKEN_PATTERN =
    /^u1\.([a-z2-7]{26})\.([a-z2-7]{26})\.([a-z-]{1,40}(?:~[a-z-]{1,40}){0,15})\.([A-Za-z0-9_-]{43})$/;

/**
 * The HMAC key for unsubscribe tokens, derived with HKDF from the rate-limit key every environment already holds, so
 * no new secret has to be deployed. Rotating that key ends old unsubscribe links, which then open the settings instead.
 */
async function deriveUnsubscribeKey(secret: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(HKDF_INFO) },
        base,
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        false,
        ['sign', 'verify'],
    );
}

/** `secret` is the rate-limit HMAC key; the derived key is made once, on first use. */
export function createHmacUnsubscribeTokens(secret: Uint8Array): UnsubscribeTokens {
    let derived: Promise<CryptoKey> | undefined;
    const key = () => (derived ??= deriveUnsubscribeKey(new Uint8Array(secret)));
    const payloadOf = (claims: UnsubscribeClaims) =>
        `${VERSION}.${claims.userId}.${claims.orgId}.${[...new Set(claims.kinds)].sort().join('~')}`;
    const bytes = (payload: string) => new TextEncoder().encode(MAC_CONTEXT + payload);
    return {
        async sign(claims) {
            const payload = payloadOf(claims);
            const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await key(), bytes(payload)));
            return `${payload}.${toBase64Url(mac)}`;
        },
        async verify(token) {
            const match = TOKEN_PATTERN.exec(token);
            if (match === null) {
                return null;
            }
            const [, userId, orgId, kindList, mac] = match as unknown as [string, string, string, string, string];
            const payload = token.slice(0, token.length - mac.length - 1);
            const macBytes = fromBase64Url(mac);
            // One spelling per token: the last character's spare bits must be zero. `verify` compares in constant time.
            if (
                toBase64Url(macBytes) !== mac ||
                !(await crypto.subtle.verify('HMAC', await key(), macBytes, bytes(payload)))
            ) {
                return null;
            }
            const kinds = kindList.split('~').map((kind) => notificationKindSchema.safeParse(kind));
            if (!kinds.every((kind) => kind.success)) {
                return null;
            }
            return {
                userId: userIdSchema.parse(userId),
                orgId: orgIdSchema.parse(orgId),
                kinds: kinds.map((kind) => kind.data),
            };
        },
    };
}

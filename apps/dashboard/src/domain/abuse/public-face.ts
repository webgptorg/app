import { sha256Hex } from '../auth/secrets';

export type PublicFaceResult = 'match' | 'mismatch' | 'unreachable';

/** One HTTP answer, as an anonymous visitor's browser would get it; only the start of the body is read. */
export interface PublicFaceResponse {
    readonly status: number;
    readonly location: string | null;
    readonly contentType: string | null;
    /** At most {@link PUBLIC_FACE_MAX_BODY_BYTES}, for the title; never stored. */
    readonly body: string;
}

/** GET without cookies, without following redirects; rejects on a network failure or when `signal` aborts. */
export interface PublicFaceFetcher {
    get(url: string, signal: AbortSignal): Promise<PublicFaceResponse>;
}

export const PUBLIC_FACE_MAX_BODY_BYTES = 64 * 1024;
/** Same-host redirects followed; the mock engine sends `/` to its sign-in page with one. */
export const PUBLIC_FACE_MAX_REDIRECTS = 3;

/** What identifies a page without keeping it: where it ended, how, as what, under which title. */
export interface PublicFaceFacts {
    readonly status: number;
    readonly path: string;
    readonly mediaType: string;
    readonly title: string;
    /** The origin an off-host redirect pointed at, which is never followed. */
    readonly redirectTo?: string;
}

/**
 * The mock engine's anonymous face (`apps/mock-engine/src/adapters/http/dev-login.ts`): `/` redirects to the sign-in
 * page. It stands in until the engine team publishes a stable marker per engine version.
 */
export const MOCK_ENGINE_SIGN_IN: PublicFaceFacts = {
    status: 200,
    path: '/auth/sign-in',
    mediaType: 'text/html',
    title: 'Sign in · Promptbook mock engine',
};

/** SHA-256 of the facts; the default fingerprint set is {@link MOCK_ENGINE_SIGN_IN}'s. */
export async function publicFaceFingerprint(facts: PublicFaceFacts): Promise<string> {
    return sha256Hex(
        JSON.stringify([facts.status, facts.path, facts.mediaType, facts.title, facts.redirectTo ?? null]),
    );
}

/** {@link publicFaceFingerprint} of {@link MOCK_ENGINE_SIGN_IN}, for config defaults (a test keeps the two in step). */
export const MOCK_ENGINE_SIGN_IN_FINGERPRINT = '89834ac973307a4cc64793d5d3f64d2cc33847d3aa3e659ffa71ba5dd0827b79';

function titleOf(body: string): string {
    const match = /<title[^>]*>([^<]*)<\/title>/i.exec(body);
    return (match?.[1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function mediaTypeOf(contentType: string | null): string {
    return (contentType ?? '').replace(/;.*$/s, '').trim().toLowerCase();
}

export interface PublicFaceCheck {
    readonly result: PublicFaceResult;
    /** Null when unreachable. */
    readonly fingerprint: string | null;
}

/**
 * Visits `https://<hostname>/` as an anonymous visitor would and compares what it lands on with the known engine
 * sign-in page. Redirects are followed on the same host only; one to another host is a mismatch and is not followed,
 * so the check never reaches past the engine hostnames we register. No answer, or a server error, is `unreachable`.
 */
export async function checkPublicFace(
    deps: { readonly fetcher: PublicFaceFetcher; readonly fingerprints: ReadonlySet<string> },
    hostname: string,
    signal: AbortSignal,
): Promise<PublicFaceCheck> {
    let url = new URL(`https://${hostname}/`);
    for (let redirects = 0; ; redirects++) {
        let response: PublicFaceResponse;
        try {
            response = await deps.fetcher.get(url.href, signal);
        } catch {
            return { result: 'unreachable', fingerprint: null };
        }
        if (response.status >= 500) {
            return { result: 'unreachable', fingerprint: null };
        }
        const facts = {
            status: response.status,
            path: url.pathname,
            mediaType: mediaTypeOf(response.contentType),
            title: titleOf(response.body),
        };
        if (response.status >= 300 && response.status < 400 && response.location !== null) {
            const next = URL.canParse(response.location, url.href) ? new URL(response.location, url) : null;
            if (next?.protocol === 'https:' && next.host === url.host && redirects < PUBLIC_FACE_MAX_REDIRECTS) {
                url = next;
                continue;
            }
            const fingerprint = await publicFaceFingerprint({ ...facts, redirectTo: next?.origin ?? 'invalid' });
            return { result: 'mismatch', fingerprint };
        }
        const fingerprint = await publicFaceFingerprint(facts);
        return { result: deps.fingerprints.has(fingerprint) ? 'match' : 'mismatch', fingerprint };
    }
}

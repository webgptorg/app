import { LinkCode } from './link-code';

/** The dashboard path a link URL names; the page there only tells a browser visitor to run the engine's command. */
export const LINK_PATH = '/link';

const MAX_LINK_URL_LENGTH = 2048;

/** Why a link URL was refused; never the URL or the code, which is a secret. */
export type LinkUrlProblem = 'not-a-url' | 'not-https' | 'credentials' | 'not-link-path' | 'query' | 'invalid-code';

export type LinkUrlParse =
    | { readonly kind: 'ok'; readonly dashboardOrigin: string; readonly linkCode: LinkCode }
    | { readonly kind: 'invalid'; readonly problem: LinkUrlProblem };

export type LinkArgumentParse =
    | {
          readonly kind: 'ok';
          /** Null for a bare code: the dashboard comes from configuration or the stored registration. */
          readonly dashboardOrigin: string | null;
          readonly linkCode: LinkCode;
      }
    | { readonly kind: 'invalid'; readonly problem: LinkUrlProblem };

function urlOf(text: string): URL | null {
    if (text.length > MAX_LINK_URL_LENGTH) return null;
    try {
        return new URL(text);
    } catch {
        return null;
    }
}

/**
 * `https://<dashboard host>/link#<code>`. The code rides in the fragment so a browser that opens the URL never sends
 * it, and no access log records it. The dashboard origin is what the engine registers with.
 */
export function parseLinkUrl(text: string): LinkUrlParse {
    const url = urlOf(text);
    if (url === null) return { kind: 'invalid', problem: 'not-a-url' };
    if (url.protocol !== 'https:') return { kind: 'invalid', problem: 'not-https' };
    if (url.username !== '' || url.password !== '') return { kind: 'invalid', problem: 'credentials' };
    if (url.pathname !== LINK_PATH) return { kind: 'invalid', problem: 'not-link-path' };
    // An empty `?` leaves `search` empty, so the text decides.
    if (url.search !== '' || text.includes('?')) return { kind: 'invalid', problem: 'query' };
    const linkCode = LinkCode.safeParse(url.hash.slice(1));
    if (!linkCode.success) return { kind: 'invalid', problem: 'invalid-code' };
    return { kind: 'ok', dashboardOrigin: url.origin, linkCode: linkCode.data };
}

/** What `connect --link` accepts: a link URL, or a bare code for setups that name the dashboard themselves. */
export function parseLinkArgument(text: string): LinkArgumentParse {
    const bare = LinkCode.safeParse(text);
    if (bare.success) return { kind: 'ok', dashboardOrigin: null, linkCode: bare.data };
    return parseLinkUrl(text);
}

/** The link URL for a dashboard's `https://` origin; throws on anything else, which is a configuration error. */
export function formatLinkUrl(dashboardOrigin: string, linkCode: LinkCode): string {
    const url = urlOf(dashboardOrigin);
    if (url?.protocol !== 'https:' || url.origin !== dashboardOrigin) {
        throw new TypeError('formatLinkUrl needs an https:// origin');
    }
    return `${dashboardOrigin}${LINK_PATH}#${linkCode}`;
}

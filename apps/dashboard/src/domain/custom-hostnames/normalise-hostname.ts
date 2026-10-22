import { Hostname } from '@ptbk/protocol';

/** The platform's own domain: nothing under it is a customer's to claim, whatever the configured engine domain is. */
export const PLATFORM_DOMAIN = Hostname.parse('ptbk.io');

// Far above any hostname, so the work below stays bounded; the protocol schema enforces the real 253.
const MAX_INPUT_LENGTH = 1024;
const OUTSIDE_PRINTABLE_ASCII = /[^ -~]/;
// Letters, marks and digits of any script, dots and hyphens: everything else (slashes, `@`, ports, brackets, other
// punctuation the URL parser would map or interpret) is refused before it gets there.
const UNICODE_HOSTNAME = /^[\p{L}\p{M}\p{N}.-]+$/u;

/**
 * The hostname as DNS, the engine's claim and the relay's SNI lookup all spell it: lowercase, without the trailing dot,
 * internationalized names as A-labels (UTS 46 through the WHATWG URL parser), then the protocol's `Hostname` rules,
 * which refuse IP literals, wildcards and names over 253 characters. Null for anything else.
 */
export function normaliseCustomHostname(input: string): Hostname | null {
    if (input.length > MAX_INPUT_LENGTH) {
        return null;
    }
    let name = input.toLowerCase();
    if (name.endsWith('.')) {
        name = name.slice(0, -1);
    }
    if (OUTSIDE_PRINTABLE_ASCII.test(name)) {
        if (!UNICODE_HOSTNAME.test(name)) {
            return null;
        }
        try {
            name = new URL(`http://${name}/`).hostname;
        } catch {
            return null;
        }
    }
    const parsed = Hostname.safeParse(name);
    return parsed.success ? parsed.data : null;
}

/** Whether `hostname` is one of `domains` or lies under one of them. */
export function isUnderAny(hostname: Hostname, domains: readonly Hostname[]): boolean {
    return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

/**
 * Web Risk's URL canonicalisation and lookup expressions, as "URLs and hashing" in its documentation specifies, for
 * the Update API: Google hashes the same expressions, so a URL is found only if it is canonicalised the same way.
 * Bytes, not characters: percent-escapes stand for bytes, and the canonical URL escapes every byte outside ASCII.
 */

const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const PERCENT = 0x25;
const HASH = 0x23;
const QUESTION = 0x3f;
const SLASH = 0x2f;

function isHex(byte: number | undefined): byte is number {
    return (
        byte !== undefined &&
        ((byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66))
    );
}

function hexValue(byte: number): number {
    return byte <= 0x39 ? byte - 0x30 : (byte | 0x20) - 0x61 + 10;
}

function unescapeOnce(bytes: readonly number[]): number[] {
    const out: number[] = [];
    for (let index = 0; index < bytes.length; index++) {
        const high = bytes[index + 1];
        const low = bytes[index + 2];
        if (bytes[index] === PERCENT && isHex(high) && isHex(low)) {
            out.push((hexValue(high) << 4) | hexValue(low));
            index += 2;
        } else {
            out.push(bytes[index] as number);
        }
    }
    return out;
}

/** Each pass removes at least one byte, so this ends; a URL is at most a few kilobytes. */
function unescapeFully(bytes: readonly number[]): number[] {
    let current = [...bytes];
    for (;;) {
        const next = unescapeOnce(current);
        if (next.length === current.length) return current;
        current = next;
    }
}

/** Every byte at or below space, at or above DEL, `#` and `%`, as uppercase escapes; the rest as ASCII. */
function escape(bytes: readonly number[]): string {
    let out = '';
    for (const byte of bytes) {
        out +=
            byte <= 0x20 || byte >= 0x7f || byte === HASH || byte === PERCENT
                ? `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
                : String.fromCharCode(byte);
    }
    return out;
}

function ascii(bytes: readonly number[]): string {
    let out = '';
    for (const byte of bytes) out += String.fromCharCode(byte);
    return out;
}
const bytesOf = (text: string) => Array.from(text, (char) => char.charCodeAt(0));

/** inet_aton's forms: one to four parts, each decimal, octal (leading 0) or hex (0x); the last fills the rest. */
function ipv4(host: string): string | null {
    const parts = host.split('.');
    if (parts.length > 4) return null;
    const values: number[] = [];
    for (const part of parts) {
        let value: number;
        if (/^0x[0-9a-f]*$/i.test(part)) value = part.length === 2 ? 0 : Number.parseInt(part.slice(2), 16);
        else if (/^0[0-7]*$/.test(part)) value = part.length === 1 ? 0 : Number.parseInt(part.slice(1), 8);
        else if (/^[1-9][0-9]*$/.test(part)) value = Number(part);
        else return null;
        values.push(value);
    }
    const last = values.pop() as number;
    if (values.some((value) => value > 255) || last >= 256 ** (4 - values.length)) return null;
    const octets = [...values];
    for (let index = 3 - values.length; index >= 0; index--) octets.push(Math.floor(last / 256 ** index) % 256);
    return octets.join('.');
}

function canonicalHost(raw: string): string {
    const withoutUser = raw.slice(raw.lastIndexOf('@') + 1);
    const withoutPort = withoutUser.replace(/:\d*$/, '');
    const host = withoutPort.replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, '');
    // Only ASCII is lowercased: other bytes stay as they are, to be escaped.
    return ipv4(host) ?? host.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function canonicalPath(raw: string): string {
    const segments: string[] = [];
    const parts = raw.split('/');
    for (const part of parts) {
        if (part === '' || part === '.') continue;
        if (part === '..') segments.pop();
        else segments.push(part);
    }
    const last = parts.at(-1);
    const directory = last === '' || last === '.' || last === '..';
    return segments.length === 0 ? '/' : `/${segments.join('/')}${directory ? '/' : ''}`;
}

export interface CanonicalUrl {
    /** e.g. `http://a.b.c/1/2.html?param=1` */
    readonly url: string;
    readonly host: string;
    readonly path: string;
    /** Without the `?`; null when the URL had none. */
    readonly query: string | null;
}

/**
 * The canonical form of `input` (UTF-8 for a string), or null when it has no host. A missing scheme is `http`, the
 * fragment and port are dropped, and the host is not converted from IDN: our engine hostnames are ASCII.
 */
export function canonicalizeUrl(input: string | Uint8Array): CanonicalUrl | null {
    const raw = typeof input === 'string' ? [...new TextEncoder().encode(input)] : [...input];
    const hashAt = raw.indexOf(HASH);
    const beforeFragment = hashAt === -1 ? raw : raw.slice(0, hashAt);
    let start = 0;
    let end = beforeFragment.length;
    while (start < end && (beforeFragment[start] as number) <= 0x20) start++;
    while (end > start && (beforeFragment[end - 1] as number) <= 0x20) end--;
    const cleaned = beforeFragment.slice(start, end).filter((byte) => byte !== TAB && byte !== CR && byte !== LF);
    const unescaped = unescapeFully(cleaned);

    const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(ascii(unescaped.slice(0, 64)));
    let scheme = 'http';
    let rest = unescaped;
    if (schemeMatch !== null) {
        const afterScheme = unescaped.slice((schemeMatch[1] as string).length + 1);
        if (afterScheme[0] === SLASH && afterScheme[1] === SLASH) {
            scheme = (schemeMatch[1] as string).toLowerCase();
            rest = afterScheme.slice(2);
        }
    }
    const queryAt = rest.indexOf(QUESTION);
    const beforeQuery = queryAt === -1 ? rest : rest.slice(0, queryAt);
    const query = queryAt === -1 ? null : rest.slice(queryAt + 1);
    const slashAt = beforeQuery.indexOf(SLASH);
    const rawHost = slashAt === -1 ? beforeQuery : beforeQuery.slice(0, slashAt);
    const rawPath = slashAt === -1 ? [] : beforeQuery.slice(slashAt);

    const host = escape(bytesOf(canonicalHost(ascii(rawHost))));
    if (host === '') return null;
    const path = escape(bytesOf(canonicalPath(ascii(rawPath))));
    const escapedQuery = query === null ? null : escape(query);
    return {
        url: `${scheme}://${host}${path}${escapedQuery === null ? '' : `?${escapedQuery}`}`,
        host,
        path,
        query: escapedQuery,
    };
}

/** The exact host and up to four suffixes from its last five components, never the top-level domain alone. */
function hostSuffixes(host: string): string[] {
    if (ipv4(host) === host) return [host];
    const components = host.split('.');
    const suffixes = [host];
    for (let index = Math.max(1, components.length - 5); index < components.length - 1; index++) {
        suffixes.push(components.slice(index).join('.'));
    }
    return suffixes;
}

/** The exact path with and without the query, and the root with up to three directories under it. */
function pathPrefixes(path: string, query: string | null): string[] {
    const directories = path.split('/').slice(1, -1);
    const prefixes: string[] = [];
    if (query !== null) prefixes.push(`${path}?${query}`);
    prefixes.push(path);
    for (let depth = 0; depth <= Math.min(3, directories.length); depth++) {
        prefixes.push(
            `/${directories
                .slice(0, depth)
                .map((directory) => `${directory}/`)
                .join('')}`,
        );
    }
    return [...new Set(prefixes)];
}

/** The host suffix and path prefix expressions Web Risk looks a canonical URL up by: at most 5 × 6 = 30. */
export function lookupExpressions(url: CanonicalUrl): readonly string[] {
    const paths = pathPrefixes(url.path, url.query);
    return [...new Set(hostSuffixes(url.host).flatMap((host) => paths.map((path) => `${host}${path}`)))];
}

/** SHA-256 of an expression, the full hash whose prefixes the threat lists hold. */
export async function expressionHash(expression: string): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(expression)));
}

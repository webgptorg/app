export type GatewayLanguage = 'en' | 'cs';

const MAX_ACCEPT_LANGUAGE_LENGTH = 1024;
const LANGUAGE_RANGE = /^(?:\*|[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*)$/;
const QUALITY = /^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i;

interface Rank {
    readonly quality: number;
    readonly position: number;
}

const outranks = (candidate: Rank | null, other: Rank | null): boolean =>
    candidate !== null &&
    candidate.quality > 0 &&
    (other === null ||
        candidate.quality > other.quality ||
        (candidate.quality === other.quality && candidate.position < other.position));

/**
 * The page language from an `Accept-Language` header: Czech only when the browser ranks it above English (by q-value,
 * then by order), English otherwise, including for an absent, oversized or malformed header. `*` counts as English.
 */
export function pickGatewayLanguage(acceptLanguage: string | null): GatewayLanguage {
    if (acceptLanguage === null || acceptLanguage.length > MAX_ACCEPT_LANGUAGE_LENGTH) return 'en';
    let english: Rank | null = null;
    let czech: Rank | null = null;
    for (const [position, item] of acceptLanguage.split(',').entries()) {
        if (item.trim() === '') continue;
        const [range = '', ...parameters] = item.split(';').map((part) => part.trim());
        if (!LANGUAGE_RANGE.test(range) || parameters.length > 1) return 'en';
        const [parameter] = parameters;
        if (parameter !== undefined && !QUALITY.test(parameter)) return 'en';
        const rank = { quality: parameter === undefined ? 1 : Number(parameter.slice(2)), position };
        const primary = range.split('-', 1)[0]?.toLowerCase();
        if ((primary === 'en' || primary === '*') && !outranks(english, rank)) english = rank;
        if (primary === 'cs' && !outranks(czech, rank)) czech = rank;
    }
    return outranks(czech, english) ? 'cs' : 'en';
}

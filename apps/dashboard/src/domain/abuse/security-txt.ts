const DAY_MS = 24 * 60 * 60 * 1000;
/** RFC 9116 asks for less than a year; half a year leaves room for a deploy that stops refreshing it. */
export const SECURITY_TXT_LIFETIME_DAYS = 180;

export interface SecurityTxtInput {
    readonly abuseEmail: string;
    readonly dashboardOrigin: string;
    readonly nowMs: number;
}

/**
 * The dashboard's `/.well-known/security.txt` (RFC 9116). Rendered from live config, so `Expires` rolls forward with
 * each day: the file cannot outlive the configuration it states, which is the staleness the field guards against.
 * Midnight UTC keeps it identical for a whole day.
 */
export function securityTxt(input: SecurityTxtInput): string {
    const today = Math.floor(input.nowMs / DAY_MS) * DAY_MS;
    const expires = new Date(today + SECURITY_TXT_LIFETIME_DAYS * DAY_MS).toISOString().replace('.000Z', 'Z');
    return [
        `Contact: mailto:${input.abuseEmail}`,
        `Expires: ${expires}`,
        `Policy: ${input.dashboardOrigin}/abuse`,
        'Preferred-Languages: en, cs',
        `Canonical: ${input.dashboardOrigin}/.well-known/security.txt`,
        '',
    ].join('\n');
}

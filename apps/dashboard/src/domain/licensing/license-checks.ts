import type { LicenseRead } from './license-contract';
import { summarizeLicense, type LicenseNotice, type OrgLicenseUsage } from './license-summary';

/**
 * Where a licence could one day stop something new from happening (website-licensing.md, "Enforcement"). Only these:
 * a running engine, its control and existing access are never checked, so they can never be cut off.
 */
export const LICENSE_CHECK_POINTS = ['engine.link', 'member.invite'] as const;
export type LicenseCheckPoint = (typeof LICENSE_CHECK_POINTS)[number];

/** `LICENSE_ENFORCEMENT`. `advisory` everywhere today: a check point warns and never denies. */
export const LICENSE_ENFORCEMENT_MODES = ['advisory', 'enforce'] as const;
export type LicenseEnforcement = (typeof LICENSE_ENFORCEMENT_MODES)[number];

export type LicenseShortfall = 'unlinked' | 'missing' | 'expired' | 'over-limit';

export type LicenseCheck =
    { readonly outcome: 'ok' } | { readonly outcome: 'warn' | 'deny'; readonly reason: LicenseShortfall };

export const LICENSE_CHECK_OK: LicenseCheck = Object.freeze({ outcome: 'ok' });

const SHORTFALLS: Readonly<Record<LicenseNotice, LicenseShortfall>> = {
    unlinked: 'unlinked',
    missing: 'missing',
    expired: 'expired',
    exceeded: 'over-limit',
};

/**
 * Whether one more engine (`engine.link`) or `adding` more people (`member.invite`) stays within the licence. Advisory
 * mode only ever warns. Enforce mode denies only on what the website said just now, or when no account is linked; a
 * stale or missing answer warns at most, so a website outage never stops anyone.
 */
export function checkLicense(input: {
    readonly point: LicenseCheckPoint;
    readonly mode: LicenseEnforcement;
    readonly linked: boolean;
    readonly read: LicenseRead;
    readonly usage: OrgLicenseUsage;
    readonly now: number;
    readonly adding?: number;
}): LicenseCheck {
    if (input.linked && input.read.kind === 'unknown') {
        return LICENSE_CHECK_OK;
    }
    const adding = input.adding ?? 1;
    const usage =
        input.point === 'engine.link'
            ? { ...input.usage, engines: input.usage.engines + adding }
            : { ...input.usage, people: input.usage.people + adding };
    const { notice } = summarizeLicense({ linked: input.linked, read: input.read, usage, now: input.now });
    if (notice === null) {
        return LICENSE_CHECK_OK;
    }
    const definite = !input.linked || input.read.kind === 'current';
    return { outcome: input.mode === 'enforce' && definite ? 'deny' : 'warn', reason: SHORTFALLS[notice] };
}

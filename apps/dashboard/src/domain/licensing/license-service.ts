import type { OrgId } from '../ids';
import type { Clock } from '../ports/clock';
import type { EngineStore } from '../registration/engine-store';
import type { TeamStore } from '../teams/team-store';
import {
    checkLicense,
    LICENSE_CHECK_OK,
    type LicenseCheck,
    type LicenseCheckPoint,
    type LicenseEnforcement,
} from './license-checks';
import type { LicenseRead, WebsiteLicenseApi } from './license-contract';
import { createLicenseReader } from './license-reader';
import { summarizeLicense, type LicenseSummary, type OrgLicenseUsage } from './license-summary';
import type { WebsiteLicensingStore, WebsiteLinkView } from './website-licensing-store';

/** What the routes that add an engine or invite people ask before they do it. */
export interface LicenseGate {
    /** `adding`: how many engines or people the action adds, 1 by default. */
    check(point: LicenseCheckPoint, orgId: OrgId, signal: AbortSignal, adding?: number): Promise<LicenseCheck>;
}

/** Without billing `website` there are no licences, so nothing is ever checked. */
export const OPEN_LICENSE_GATE: LicenseGate = { check: () => Promise.resolve(LICENSE_CHECK_OK) };

export interface LicenseOverview {
    readonly link: WebsiteLinkView | null;
    readonly summary: LicenseSummary;
    /** Each check point as it would answer now, so the screens can warn before anyone acts. */
    readonly checks: Readonly<Record<LicenseCheckPoint, LicenseCheck>>;
}

export function createLicenseService(deps: {
    readonly mode: LicenseEnforcement;
    readonly api: WebsiteLicenseApi;
    readonly store: WebsiteLicensingStore;
    readonly engines: Pick<EngineStore, 'countActive'>;
    readonly teams: Pick<TeamStore, 'listOrgMembers'>;
    readonly clock: Clock;
}) {
    const reader = createLicenseReader({ api: deps.api, store: deps.store, nowMs: () => deps.clock.nowMs() });

    async function inputs(orgId: OrgId, signal: AbortSignal) {
        const [link, engines, people] = await Promise.all([
            deps.store.linkForOrg(orgId),
            deps.engines.countActive(orgId),
            deps.teams.listOrgMembers(orgId),
        ]);
        const read: LicenseRead = link === null ? { kind: 'unknown' } : await reader.read(orgId, signal);
        const usage: OrgLicenseUsage = { engines, people: people.length };
        return { link, linked: link !== null, read, usage, now: deps.clock.nowMs() };
    }

    const gate: LicenseGate = {
        async check(point, orgId, signal, adding) {
            // Advisory, the gate never reads: a slow website must not slow linking or inviting. The screens show the
            // same checks as warnings, from the overview.
            if (deps.mode === 'advisory') {
                return LICENSE_CHECK_OK;
            }
            const read = await inputs(orgId, signal);
            return checkLicense({ ...read, point, mode: deps.mode, ...(adding === undefined ? {} : { adding }) });
        },
    };

    return {
        gate,
        async overview(orgId: OrgId, signal: AbortSignal): Promise<LicenseOverview> {
            const read = await inputs(orgId, signal);
            return {
                link: read.link,
                summary: summarizeLicense(read),
                checks: {
                    'engine.link': checkLicense({ ...read, point: 'engine.link', mode: deps.mode }),
                    'member.invite': checkLicense({ ...read, point: 'member.invite', mode: deps.mode }),
                },
            };
        },
    };
}

export type LicenseService = ReturnType<typeof createLicenseService>;

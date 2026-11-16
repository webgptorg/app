import type { OrgId } from '../ids';
import type { WebsiteLicenseStore } from './license-contract';
import type { WebsiteHandoffStore } from './website-access';
import type { WebsiteIdentityLinkStore } from './website-handoff';

export interface WebsiteLinkView {
    readonly subject: string;
    readonly linkedAt: number;
    /** The address of whoever linked it, which the website verified as its own; null once that person left. */
    readonly linkedByEmail: string | null;
}

/** Account and licence metadata only: a website subject per organization and the last licence snapshot. */
export interface WebsiteLicensingStore extends WebsiteHandoffStore, WebsiteIdentityLinkStore, WebsiteLicenseStore {
    linkForOrg(orgId: OrgId): Promise<WebsiteLinkView | null>;
}

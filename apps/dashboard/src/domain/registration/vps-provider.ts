import type { LinkCode } from '@ptbk/protocol';
import type { EngineInstallRelease } from '../../shared/engine-installation';

export interface VpsGrant {
    /** Transient credential, held only while checking the offer and creating one server. */
    readonly token: string;
    readonly ownerDigest: string;
}

export type VpsCreateResult = { kind: 'created'; resourceId: string } | { kind: 'rejected' } | { kind: 'unknown' };

/** Each provider owns its authorization, quote and provisioning API. */
export interface VpsProvider {
    clientId(signal: AbortSignal): Promise<string>;
    authorize(code: string, verifier: string, signal: AbortSignal): Promise<VpsGrant>;
    checkPrice(grant: VpsGrant, signal: AbortSignal): Promise<boolean>;
    bootstrap(release: EngineInstallRelease, code: LinkCode, grant: VpsGrant): string;
    create(grant: VpsGrant, name: string, userData: string): Promise<VpsCreateResult>;
    revoke(grant: VpsGrant): Promise<void>;
}

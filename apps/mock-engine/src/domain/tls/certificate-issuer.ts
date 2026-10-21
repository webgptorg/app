import type { Hostname } from '@ptbk/protocol';

import type { TlsCredentials } from './certificate-source';

/**
 * Obtains one certificate for a set of hostnames from a CA. The ACME source schedules, stores and retries; the issuer
 * only runs one issuance, so the production ACME client (the engine team's choice) replaces this one adapter.
 */
export interface CertificateIssuer {
    /** Rejects on any failure, and once `signal` aborts; the key it returns was generated locally for this request. */
    issue(hostnames: readonly Hostname[], signal: AbortSignal): Promise<TlsCredentials>;
}

/** What went wrong, by stage only: CA responses can carry URLs with tokens, so their text is never logged. */
export class IssueFailedError extends Error {
    readonly stage: IssueStage;
    constructor(stage: IssueStage, options?: ErrorOptions) {
        super(`ACME ${stage} failed`, options);
        this.name = 'IssueFailedError';
        this.stage = stage;
    }
}

export type IssueStage = 'account' | 'order' | 'challenge' | 'finalize' | 'download';

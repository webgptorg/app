import type { ReadSecurityOverview } from '@ptbk/engine-api';

import { m } from '../../paraglide/messages';

type Overview = ReadSecurityOverview;
export type UpdateStatus = Overview['update']['status'];
export type RelayStatus = Overview['relays'][number]['status'];
export type CtResult = NonNullable<Overview['tls']['lastCtCheck']>['result'];
export type CheckOutcome = NonNullable<Overview['ui']['lastUpdateCheck']>['outcome'];
export type RefusalReason = NonNullable<NonNullable<Overview['ui']['lastUpdateCheck']>['reason']>;
export type RevocationReason = NonNullable<NonNullable<Overview['ui']['lastUpdateCheck']>['revocationReason']>;
export type CertificateStatus = NonNullable<Overview['hostnames'][number]['certificateStatus']>;

const UPDATE_STATUS: Readonly<Record<UpdateStatus, () => string>> = {
    none: m.security_update_none,
    available: m.security_update_available,
    pending: m.security_update_pending,
    installing: m.security_update_installing,
};

const RELAY_STATUS: Readonly<Record<RelayStatus, () => string>> = {
    connected: m.security_relay_connected,
    connecting: m.security_relay_connecting,
    disconnected: m.security_relay_disconnected,
};

const CT_RESULT: Readonly<Record<CtResult, () => string>> = {
    ok: m.security_ct_ok,
    'unexpected-certificate': m.security_ct_unexpected,
    failed: m.security_ct_failed,
};

const CHECK_OUTCOME: Readonly<Record<CheckOutcome, () => string>> = {
    'up-to-date': m.security_check_up_to_date,
    installed: m.security_check_installed,
    refused: m.security_check_refused,
    unavailable: m.security_check_unavailable,
    unknown: m.security_value_unknown,
};

const REFUSAL_REASON: Readonly<Record<RefusalReason, () => string>> = {
    'invalid-entry': m.security_refusal_invalid_entry,
    'signature-threshold-not-met': m.security_refusal_signatures,
    'not-in-log': m.security_refusal_not_in_log,
    revoked: m.security_refusal_revoked,
    'not-newer': m.security_refusal_not_newer,
    'delay-not-elapsed': m.security_refusal_delay,
    'hash-mismatch': m.security_refusal_hash_mismatch,
    manifest: m.security_refusal_manifest,
    'engine-api': m.security_refusal_engine_api,
    unpack: m.security_refusal_unpack,
    'revocations-unverifiable': m.security_refusal_revocations,
    unknown: m.security_value_unknown,
};

const REVOCATION_REASON: Readonly<Record<RevocationReason, () => string>> = {
    missing: m.security_revocation_missing,
    invalid: m.security_revocation_invalid,
    expired: m.security_revocation_expired,
    'rolled-back': m.security_revocation_rolled_back,
    unknown: m.security_value_unknown,
};

const CERTIFICATE_STATUS: Readonly<Record<CertificateStatus, () => string>> = {
    valid: m.security_certificate_valid,
    pending: m.security_certificate_pending,
    expiring: m.security_certificate_expiring,
    expired: m.security_certificate_expired,
    error: m.security_certificate_error,
    unknown: m.security_value_unknown,
};

export const updateStatusLabel = (status: UpdateStatus) => UPDATE_STATUS[status]();
export const relayStatusLabel = (status: RelayStatus) => RELAY_STATUS[status]();
export const ctResultLabel = (result: CtResult) => CT_RESULT[result]();
export const checkOutcomeLabel = (outcome: CheckOutcome) => CHECK_OUTCOME[outcome]();
export const refusalReasonLabel = (reason: RefusalReason) => REFUSAL_REASON[reason]();
export const revocationReasonLabel = (reason: RevocationReason) => REVOCATION_REASON[reason]();
/** `null` is an engine on API 1.2, which does not report it. */
export const certificateStatusLabel = (status: CertificateStatus | null) =>
    status === null ? m.security_not_reported() : CERTIFICATE_STATUS[status]();

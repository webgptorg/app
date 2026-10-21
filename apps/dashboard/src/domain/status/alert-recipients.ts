import type { OrgId } from '../ids';
import type { AlertRecipient } from './engine-status';

/** Who hears that an engine went offline. Later roles or alert settings change only the adapter. */
export interface AlertRecipients {
    forEngineOffline(orgId: OrgId, signal: AbortSignal): Promise<readonly AlertRecipient[]>;
}

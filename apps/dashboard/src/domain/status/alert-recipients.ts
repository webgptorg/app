import type { OrgId } from '../ids';
import type { AlertRecipient } from './engine-status';

/** Who hears that an engine came online, went offline or came back. Later roles or settings change only the adapter. */
export interface AlertRecipients {
    forEngineStatus(orgId: OrgId, signal: AbortSignal): Promise<readonly AlertRecipient[]>;
}

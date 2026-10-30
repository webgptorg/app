import type { EngineId } from '@ptbk/protocol';

import type { OrgId } from '../ids';
import type { AlertRecipient } from './engine-status';

/**
 * Who hears that an engine came online, went offline or came back: the organization's owners and admins who are in the
 * engine's team, or the owners when none of them is (teams spec, "Engine emails"); always with a verified email.
 */
export interface AlertRecipients {
    forEngineStatus(orgId: OrgId, engineId: EngineId, signal: AbortSignal): Promise<readonly AlertRecipient[]>;
}

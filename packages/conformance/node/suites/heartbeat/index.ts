import type { PlatformSuite } from '../../harness/platform';
import { bodyStrict, seqIncreasing, signatureVerifies } from './beats';
import { cadenceInterval, errorsKeepSending, staleSkewShown } from './timing';

/** Acting as the dashboard: the signed heartbeat (Interface 4, heartbeat.md). */
export const HEARTBEAT_SUITE: PlatformSuite = {
    id: 'heartbeat',
    checks: [signatureVerifies, bodyStrict, seqIncreasing, cadenceInterval, errorsKeepSending, staleSkewShown],
};

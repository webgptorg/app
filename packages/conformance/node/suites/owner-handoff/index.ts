import type { PlatformSuite } from '../../harness/platform';
import { HANDOFF_CHECKS, SUITE, signalAbsentWithoutCommitment } from './handoff';

/**
 * Acting as the dashboard and the pairing tab (ADR 0023): the second setup slot from the registration answer, the
 * heartbeat signal, and the setup page's endpoints through a fake relay. An engine that never signals skips.
 */
export const OWNER_HANDOFF_SUITE: PlatformSuite = {
    id: SUITE,
    checks: [...HANDOFF_CHECKS, signalAbsentWithoutCommitment],
};

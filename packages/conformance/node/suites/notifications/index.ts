import type { PlatformSuite } from '../../harness/platform';
import { ATTENTION_CHECKS, SUITE } from './attention';

/**
 * Acting as the dashboard (ADR 0027): what heartbeat v2's `attention` may say about an engine's inbox. An engine
 * without `notifications@1`, without teams or without the test-mode lever skips.
 */
export const NOTIFICATIONS_SUITE: PlatformSuite = { id: SUITE, checks: [...ATTENTION_CHECKS] };

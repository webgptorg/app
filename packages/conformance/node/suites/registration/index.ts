import type { PlatformSuite } from '../../harness/platform';
import { signatureVerifies } from './request';

/** Acting as the dashboard: how the engine registers (Interface 1) and keeps its identity (identity-and-registration.md). */
export const REGISTRATION_SUITE: PlatformSuite = {
    id: 'registration',
    checks: [signatureVerifies],
};

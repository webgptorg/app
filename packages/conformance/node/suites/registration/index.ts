import type { PlatformSuite } from '../../harness/platform';
import { ERROR_CHECKS } from './errors';
import { engineIdDerived, linkCodeUsedOnce, stableAcrossRestarts } from './identity';
import { dataDirPrivate, keyFilePrivate, looseModesRefused } from './key-handling';
import { signatureVerifies } from './request';
import { invalidRefused, unknownFieldsIgnored } from './responses';
import { secretsNeverLogged } from './secrets';

/** Acting as the dashboard: how the engine registers (Interface 1) and keeps its identity (identity-and-registration.md). */
export const REGISTRATION_SUITE: PlatformSuite = {
    id: 'registration',
    checks: [
        signatureVerifies,
        engineIdDerived,
        stableAcrossRestarts,
        linkCodeUsedOnce,
        secretsNeverLogged,
        unknownFieldsIgnored,
        invalidRefused,
        ...ERROR_CHECKS,
        dataDirPrivate,
        keyFilePrivate,
        looseModesRefused,
    ],
};

import { z } from 'zod';

import { ProductionTrustPolicy } from './trust';

/** The one variable through which a conformance build takes its test trust; see {@link ConformanceTrustFile}. */
export const CONFORMANCE_TRUST_FILE_ENV = 'PTBK_CONFORMANCE_TRUST_FILE';

/**
 * The test trust the conformance suite hands an engine: it replaces the pinned trust policy and the pinned Sigstore
 * trusted root (`trusted_root.json`, checked by the engine's own Sigstore verifier), and nothing else.
 *
 * Only a conformance build of the engine reads it: one built with a compile-time constant that release builds set
 * off, so the code path is not in what ships. A production build that sees the variable set refuses to start with an
 * error naming it, never ignoring it silently, because whoever chose this file would choose the code on the engine's
 * origin.
 *
 * The policy is always a production one: the suite checks that engines wait out the production delays.
 */
export const ConformanceTrustFile = z.strictObject({
    v: z.literal(1),
    trustPolicy: ProductionTrustPolicy,
    trustedRoot: z.record(z.string(), z.unknown()),
});
export type ConformanceTrustFile = z.infer<typeof ConformanceTrustFile>;

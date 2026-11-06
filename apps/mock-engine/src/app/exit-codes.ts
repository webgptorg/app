/**
 * One-shot commands exit with one code per class, so an installer or a script can react without parsing text
 * (installation.md, "First-start output").
 */
export const EXIT_CODE = Object.freeze({
    ok: 0,
    /** Anything else: a broken data directory, an engine that does not answer its control channel. */
    failed: 1,
    usage: 2,
    linkCodeRefused: 3,
    /** `engine-exists`, `engine-suspended`. */
    identityRefused: 4,
    /** `engine-limit`, `not-entitled`. */
    plan: 5,
    /** The dashboard stayed unreachable for the whole retry window. */
    unreachable: 6,
    /** The dashboard's answer did not match this engine, or it refused our signature. */
    answerRefused: 7,
    /** `setup-link`: the engine already has an owner; only `owner --reset` reopens setup. */
    ownerExists: 8,
    /** `setup-link --no-wait`, or a wait that ran out: the address does not work yet. */
    notReady: 9,
} as const);

export type ExitCode = (typeof EXIT_CODE)[keyof typeof EXIT_CODE];

import type { EngineVersion } from '@ptbk/protocol';

/**
 * `PTBK_UPDATE_POLICY` (spec, Updates): `auto` installs the newest release once its delay has passed; `manual` installs
 * only when the owner approves a check, which skips the delay and nothing else; `pinned` installs exactly that
 * version, also without waiting for the delay.
 */
export type UpdatePolicy =
    | { readonly kind: 'auto' }
    | { readonly kind: 'manual' }
    | { readonly kind: 'pinned'; readonly version: EngineVersion };

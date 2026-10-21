import type { ConformanceSuite } from '../../check';
import { notImplemented } from '../../check';

const SUITE = 'ui-loader';

/** The engine's UI loader (M-05). Registered now, as `skip`, so engine teams can track ADR 0014's requirements. */
export const UI_LOADER_SUITE: ConformanceSuite = {
    id: SUITE,
    checks: [
        notImplemented({
            id: 'ui-loader.signature.strict-ed25519',
            suite: SUITE,
            title: "Releases signed with C-01's ed25519-vectors.json cases get exactly the recorded accept or reject",
        }),
        notImplemented({
            id: 'ui-loader.dsse.pae-only',
            suite: SUITE,
            title: 'A signature over the raw payload, a changed payload byte or a wrong payloadType is refused',
        }),
        notImplemented({
            id: 'ui-loader.provenance.exact-identity',
            suite: SUITE,
            title: 'Provenance from the wrong repository, commit, ref or runner is refused',
        }),
        notImplemented({
            id: 'ui-loader.delay.trusted-time',
            suite: SUITE,
            title: 'A backdated publishedAt does not shorten the update delay',
        }),
        notImplemented({
            id: 'ui-loader.revocations.expired-keeps-current',
            suite: SUITE,
            title: 'An expired revocation list keeps the current version',
        }),
    ],
};

import type { ConformanceSuite } from '../../check';
import { notImplemented } from '../../check';

const SUITE = 'tunnel';

/**
 * Acting as a relay against the engine's tunnel client. Registered now, as `skip`, so engine teams can track the
 * cryptographic requirements of ADR 0014 before the suite exists; it needs to host a server, so it will be Node-only.
 */
export const TUNNEL_SUITE: ConformanceSuite = {
    id: SUITE,
    checks: [
        notImplemented({
            id: 'tunnel.negotiation.downgrade-refused',
            suite: SUITE,
            title: 'A ready with a lower version, a missing or an extra feature makes the engine close with PROTOCOL_ERROR',
        }),
        notImplemented({
            id: 'tunnel.auth.list-encoding',
            suite: SUITE,
            title: "Unsorted version and feature lists in challenge still get an auth that C-02's verifyTunnelAuth accepts",
        }),
        notImplemented({
            id: 'tunnel.auth.version-signed',
            suite: SUITE,
            title: 'The auth signature verifies only over the version the engine sent',
        }),
    ],
};

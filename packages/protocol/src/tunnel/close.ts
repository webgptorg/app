/**
 * WebSocket close codes of the tunnel (private range 4000–4999). These names are the contract: relay, engines and docs
 * use them exactly. The one reject outside this range is `rate-limited`, which closes with the standard 1013 (Try Again
 * Later) so generic clients and proxies read it as "retry later".
 */
export const TUNNEL_CLOSE_CODE = Object.freeze({
    /** A newer tunnel for the same engine took over this relay slot; the engine must not reconnect in a loop. */
    REPLACED: 4000,
    AUTH_FAILED: 4001,
    PROTOCOL_ERROR: 4002,
    /** The relay drains; reconnect, preferably to another relay. */
    SHUTTING_DOWN: 4003,
    SUSPENDED: 4004,
} as const);

export type TunnelCloseCode = (typeof TUNNEL_CLOSE_CODE)[keyof typeof TUNNEL_CLOSE_CODE];

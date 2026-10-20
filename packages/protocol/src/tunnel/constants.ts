/** The engine dials `wss://<relayId>/v1/tunnel`. */
export const TUNNEL_PATH = '/v1/tunnel';
/** Names the protocol only; the version is negotiated in the handshake (ADR 0010 §2). */
export const TUNNEL_SUBPROTOCOL = 'ptbk-tunnel';
/** Protocol versions this package implements. */
export const TUNNEL_PROTOCOL_VERSIONS = [1] as const;
/** Feature flags this package knows; v1 defines none. */
export const TUNNEL_FEATURES = [] as const;

export const PING_INTERVAL_MS = 25_000;
/** How long the relay waits for `auth` after sending `challenge`. */
export const AUTH_TIMEOUT_MS = 10_000;
/** Credit each direction of a stream starts with, in DATA payload bytes. */
export const INITIAL_WINDOW_BYTES = 262_144;
export const MAX_FRAME_PAYLOAD_BYTES = 65_536;
/** UTF-8 bytes of one handshake text message; longer messages are refused before parsing. */
export const MAX_HANDSHAKE_MESSAGE_BYTES = 4_096;
export const NONCE_BYTES = 32;
/** u16, so engines in any language can hold a version in a fixed-width integer. */
export const MAX_PROTOCOL_VERSION = 65_535;

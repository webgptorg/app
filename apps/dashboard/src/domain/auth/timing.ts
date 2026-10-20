const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export const CHALLENGE_TTL_MS = 5 * MINUTE_MS;
export const EMAIL_TOKEN_TTL_MS = 15 * MINUTE_MS;
export const SESSION_IDLE_MS = 7 * DAY_MS;
export const SESSION_ABSOLUTE_MS = 30 * DAY_MS;
/** `last_seen_at` is written at most this often, so reading a session is not a write on every request. */
export const SESSION_TOUCH_INTERVAL_MS = MINUTE_MS;

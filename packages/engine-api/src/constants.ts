/** Every engine API path starts with this prefix; a breaking change ships as `/api/v2` next to it (ADR 0010). */
export const ENGINE_API_PREFIX = '/api/v1';

/**
 * SemVer of this contract. Additive changes bump the minor; the UI bundle manifest's `engineApi` range refers to it
 * (C-06, X-03), so the engine's loader refuses a bundle built against an API it does not speak.
 */
export const ENGINE_API_VERSION = '1.2.0';

/** Gateway pages owned by the open engine, not by this API. */
export const SIGN_IN_PATH = '/auth/sign-in';
export const SIGN_OUT_PATH = '/auth/sign-out';
export const STEP_UP_PATH = '/auth/step-up';

/** Path prefixes the UI loader's SPA fallback must never shadow. */
export const ENGINE_RESERVED_PATHS = ['/api/', '/auth/', '/setup', '/.well-known/'] as const;

/**
 * The exact Content-Security-Policy the engine sends with the UI. The bundle, the mock engine, conformance and the real
 * engine all use this one string, so it can only change here.
 */
export const ENGINE_UI_CSP =
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-src 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types ptbk-html";

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;
export const MAX_CURSOR_LENGTH = 1024;

/** In UTF-16 code units, as JavaScript measures strings. */
export const MAX_BOOK_SOURCE_LENGTH = 512 * 1024;
export const MAX_MESSAGE_LENGTH = 64 * 1024;
/** A chat's `preview`: its first user message, cut to this length. */
export const MAX_CHAT_PREVIEW_LENGTH = 200;
export const MAX_SECRET_VALUE_LENGTH = 64 * 1024;

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Run logs and diffs, in UTF-8 bytes; the engine truncates longer text and sets the matching `*Truncated` flag. */
export const MAX_RUN_TEXT_BYTES = 256 * 1024;

/** The engine truncates the `User-Agent` it records in the audit log and session list to this many characters. */
export const MAX_USER_AGENT_LENGTH = 512;

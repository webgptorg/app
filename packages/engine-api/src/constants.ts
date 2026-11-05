/** Every engine API path starts with this prefix; a breaking change ships as `/api/v2` next to it (ADR 0010). */
export const ENGINE_API_PREFIX = '/api/v1';

/**
 * SemVer of this contract. Additive changes bump the minor; the UI bundle manifest's `engineApi` range refers to it
 * (C-06, X-03), so the engine's loader refuses a bundle built against an API it does not speak.
 */
export const ENGINE_API_VERSION = '1.14.0';

/** Gateway pages owned by the open engine, not by this API. */
export const SIGN_IN_PATH = '/auth/sign-in';
export const SIGN_OUT_PATH = '/auth/sign-out';
export const STEP_UP_PATH = '/auth/step-up';

/**
 * The join page (ADR 0018) and its JSON endpoints, which the conformance suite drives without a browser. Each takes a
 * same-origin `POST`: options `{ ticket }` answers 200 `{ options }` (WebAuthn creation options); verify
 * `{ ticket, response }` answers 201 `{ code, request }`, the 6-digit code and an opaque token for status; status
 * `{ request }` answers 200 `{ state }`, `waiting`, `declined`, or `approved` with `next` and the session cookie.
 */
export const JOIN_PATH = '/auth/join';
export const JOIN_OPTIONS_PATH = '/auth/join/options';
export const JOIN_VERIFY_PATH = '/auth/join/verify';
export const JOIN_STATUS_PATH = '/auth/join/status';

/** The join endpoints' problem codes, each one state of the page. */
export const JOIN_PROBLEM = {
    /** 403: no member key pinned, a bad signature, a malformed ticket or one for another engine. */
    ticketInvalid: 'ticket-invalid',
    /** 403: past `expiresAt`, or not valid yet. */
    ticketExpired: 'ticket-expired',
    /** 409: this `ticketId` already made a request. */
    ticketUsed: 'ticket-used',
    /** 409: the ticket's person is already an active member; they sign in instead. */
    alreadyMember: 'already-member',
    /** 409: `MAX_PENDING_ACCESS_REQUESTS` are waiting. */
    tooManyRequests: 'too-many-requests',
    /** 400: the passkey's registration response did not verify. */
    passkeyNotVerified: 'passkey-not-verified',
    /** 404 from status: no such request token. */
    requestUnknown: 'join-request-unknown',
} as const;

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
/** A run's `preview`: the text that started it, cut to this length. */
export const MAX_RUN_PREVIEW_LENGTH = 200;
/** A test chat (`test-chat@1`) carries its whole conversation in every request; at most this many turns. */
export const MAX_TEST_CHAT_MESSAGES = 50;
/** The test conversation's messages together, in UTF-16 code units, on top of the book itself. */
export const MAX_TEST_CHAT_TRANSCRIPT_LENGTH = 256 * 1024;

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Run logs and diffs, in UTF-8 bytes; the engine truncates longer text and sets the matching `*Truncated` flag. */
export const MAX_RUN_TEXT_BYTES = 256 * 1024;

/** The engine truncates the `User-Agent` it records in the audit log and session list to this many characters. */
export const MAX_USER_AGENT_LENGTH = 512;

/** An audit entry's `details` serialised as JSON, in UTF-8 bytes. */
export const MAX_AUDIT_DETAILS_BYTES = 16 * 1024;
/** How deeply an audit entry's `details` may nest; the `details` object itself is depth 1. */
export const MAX_AUDIT_DETAILS_DEPTH = 8;
/** An audit target's `name`, in UTF-16 code units. */
export const MAX_AUDIT_TARGET_NAME_LENGTH = 256;

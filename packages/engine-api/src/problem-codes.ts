import { z } from 'zod';

/** Every problem code with the HTTP status it is always sent with. */
export const PROBLEM_STATUS = {
    'validation-failed': 400,
    'invalid-cursor': 400,
    unauthenticated: 401,
    'step-up-required': 401,
    forbidden: 403,
    'not-found': 404,
    /** The engine does not advertise the capability this route belongs to. */
    'capability-not-supported': 404,
    'agent-deleted': 409,
    /** The agent is a `system` agent, defined by the engine (Expert): it cannot be changed, deleted or restored. */
    'agent-engine-owned': 409,
    'revision-conflict': 409,
    'folder-not-empty': 409,
    'name-taken': 409,
    /** The Wallet is not set up or not unlocked on the server; that is fixed there, not through the API. */
    'wallet-not-ready': 409,
    /** The Wallet request moved to another step since the client showed it. */
    'wallet-request-moved': 409,
    'last-passkey': 409,
    /** Removing or demoting the engine's last owner would leave nobody to manage it. */
    'last-owner': 409,
    'reply-finished': 409,
    /** The thread has no failed reply waiting for a recheck. */
    'nothing-to-retry': 409,
    /** A new thread names no agent and the engine has no usable Chatter to start it with. */
    'chatter-missing': 409,
    /** A `requestKey` already used for a different request. */
    'request-key-reused': 409,
    cancelled: 409,
    'run-finished': 409,
    'run-not-retryable': 409,
    'trigger-ended': 409,
    'file-infected': 409,
    /** The answer is to an onboarding prompt the engine has moved past; read the state again. */
    'onboarding-prompt-stale': 409,
    /** "Skip for now" while the engine has no project yet (`canDefer` false); answers stay saved. */
    'onboarding-not-deferrable': 409,
    /** Someone else controls this browser tab; one controller at a time. */
    'browser-tab-controlled': 409,
    /** `MAX_BROWSER_PARTICIPANTS` − 1 watchers are open on this tab; the last place is kept for a controller. */
    'browser-tab-full': 409,
    /** Another sign-in session is open on the engine; one at a time. */
    'browser-busy': 409,
    'browser-session-ended': 409,
    /** The live session's channel is already attached; one attachment per participant. */
    'live-channel-attached': 409,
    /** The help request was already resolved; its `resolution` says how. */
    'browser-help-resolved': 409,
    /** Speech was asked of a message that is still being written, failed, was cancelled or has no text. */
    'message-not-speakable': 409,
    /** The AI tool is not installed on the engine; it is installed on the host or through setup, not here. */
    'ai-tool-not-installed': 409,
    /** The answer is to a sign-in prompt the engine has moved past; read the sign-in again. */
    'ai-tool-sign-in-stale': 409,
    'payload-too-large': 413,
    'unsupported-media-type': 415,
    'invalid-book': 422,
    /** The code typed to approve an access request is not the one shown to the person asking. */
    'access-code-mismatch': 422,
    'invalid-schedule': 422,
    /** The engine's own origin, or one outside its allowlist for remote sign-in. */
    'browser-origin-refused': 422,
    /** The decoded clip is longer than `MAX_VOICE_CLIP_MS`. */
    'voice-clip-too-long': 422,
    /** The message's text is longer than `MAX_SPEECH_TEXT_LENGTH`. */
    'speech-too-long': 422,
    /** The AI tool cannot be signed in this way from the browser; its `signInMethods` lists the ways it can. */
    'ai-tool-method-unsupported': 422,
    'rate-limited': 429,
    'internal-error': 500,
    'reply-failed': 502,
    /** The engine or its provider could not transcribe this clip (unreadable audio included); recording again may help. */
    'transcription-failed': 502,
    /** The engine or its provider could not make the audio; asking again later may help. */
    'speech-failed': 502,
    unavailable: 503,
    /**
     * The capability is advertised, but no speech provider is ready right now (a harness signed out, a provider down).
     * Runtime, not a missing capability: the UI keeps the control and says voice is unavailable for now.
     */
    'voice-unavailable': 503,
    /**
     * Work could not start because an AI tool it runs on needs signing in again (an expired or revoked sign-in, a
     * removed key). The problem's `aiToolId` names the tool, so the UI can offer "Sign in again" (`ai-tools@1`).
     */
    'ai-tool-sign-in-required': 503,
} as const satisfies Record<string, number>;

export type ProblemCode = keyof typeof PROBLEM_STATUS;
export const PROBLEM_CODES = Object.keys(PROBLEM_STATUS) as readonly ProblemCode[];
export const ProblemCode = z.enum(PROBLEM_CODES as [ProblemCode, ...ProblemCode[]]);

const PROBLEM_TYPE_BASE = 'https://ptbk.io/problems/';

/** The RFC 9457 `type` URI for a code. It identifies the problem; clients branch on `code`, never on `type`. */
export function problemType(code: ProblemCode): string {
    return `${PROBLEM_TYPE_BASE}${code}`;
}

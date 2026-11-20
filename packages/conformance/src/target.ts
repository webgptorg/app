import type { BrowserHelpReason, EngineApiRouteId, Permission } from '@ptbk/engine-api';

/**
 * Who a session is for. Subjects are permission sets, never role names: which role holds which permission is engine
 * policy (C-04), and the contract only guarantees that the owner holds every permission.
 */
export type SessionSubject =
    { readonly kind: 'owner' } | { readonly kind: 'member'; readonly permissions: readonly Permission[] };

/** `cookie` is the whole `Cookie` header value (`name=value`); `bearer` goes into `Authorization: Bearer`. */
export type SessionCredential = { readonly cookie: string } | { readonly bearer: string };

/**
 * Resources the engine's policy keeps private to the member who created them, so that a second member holding the
 * same permissions gets 403 or 404 on them. Engine policy, not contract: a target reports what its engine does.
 */
export interface MemberPrivateResources {
    /** The permission set both members hold. */
    readonly permissions: readonly Permission[];
    /** Routes that act on one agent; the second member must not reach an agent the first one created. */
    readonly agentRoutes: readonly EngineApiRouteId[];
}

/**
 * The engine under test. Each engine implements `session` its own way (the mock engine through its dev-only control
 * listener); `null` means the target cannot provide that subject, and the checks that need it are skipped.
 */
export interface ConformanceTarget {
    /** The engine's origin, e.g. `https://<engineId>.<engine domain>`; the API lives under `ENGINE_API_PREFIX`. */
    readonly baseUrl: URL;
    readonly fetch: typeof fetch;
    session(subject: SessionSubject): Promise<SessionCredential | null>;
    /** The engine's Ed25519 public key (base64url), so `GET /engine`'s `engineId` can be checked against it. */
    readonly enginePublicKey?: string;
    /** `false` when the API is tested without the engine gateway in front of it; gateway checks then skip. */
    readonly gateway?: boolean;
    readonly memberPrivateResources?: MemberPrivateResources;
    /**
     * Raises a pending Wallet login request for `origin` as agent work would, and answers its ID: a test-mode lever.
     * Without it, `engine-api.wallet.requests` skips.
     */
    readonly walletRequest?: (origin: string) => Promise<string>;
    /** How the checks reach `browser-tab@1`'s channel and test-mode levers; without it those checks skip. */
    readonly liveBrowser?: LiveBrowserTarget;
}

/** One event on a live channel as the test sees it, in arrival order. */
export type LiveChannelEvent =
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'binary'; readonly bytes: Uint8Array }
    | { readonly kind: 'closed'; readonly code: number };

/** A live channel the test drives. */
export interface LiveChannelClient {
    send(data: string | Uint8Array): void;
    /** The next event, or `null` if none arrives within `timeoutMs`. After `closed`, every call answers `closed`. */
    next(timeoutMs: number): Promise<LiveChannelEvent | null>;
    close(): void;
}

/** The upgrade was refused with this HTTP status, or the channel opened. */
export type LiveChannelOpen =
    | { readonly kind: 'open'; readonly channel: LiveChannelClient }
    | { readonly kind: 'refused'; readonly status: number };

/** Where a lever sends the tab: a web origin, or a page whose frames must never leave the engine. */
export type LiveBrowserPage =
    | { readonly kind: 'web'; readonly origin: string }
    | { readonly kind: 'browser-page' }
    | { readonly kind: 'secret-page' };

/**
 * `browser-tab@1` from the outside. `openChannel` is a WebSocket upgrade at `LIVE_CHANNEL_PATH` with subprotocol
 * `LIVE_CHANNEL_SUBPROTOCOL`, the credential's `Cookie` (none when `null`) and this `Origin`. The levers are test-mode
 * hooks into the engine's browser, as `walletRequest` is into its Wallet; a real engine offers them only in test mode.
 */
export interface LiveBrowserTarget {
    openChannel(sessionId: string, credential: SessionCredential | null, origin: string): Promise<LiveChannelOpen>;
    /** An origin on the engine's remote sign-in allowlist. */
    readonly signInOrigin: string;
    /** Agent work opens a tab at `origin`, linked to no chat, task or run; answers the tab's ID. */
    openAgentTab(origin: string): Promise<string>;
    /** The agent working in the tab asks for help; answers the request's ID. */
    requestHelp(tabId: string, reason: BrowserHelpReason, message: string): Promise<string>;
    navigate(tabId: string, page: LiveBrowserPage): Promise<void>;
    /** The session behaves as if its `endsAt` (`expired`) or its controller's idle limit (`idle`) passed now. */
    elapse(sessionId: string, what: 'expired' | 'idle'): Promise<void>;
}

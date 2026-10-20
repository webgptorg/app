import type { EngineApiRouteId, Permission } from '@ptbk/engine-api';

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
}

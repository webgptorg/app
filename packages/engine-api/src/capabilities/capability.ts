import { z } from 'zod';

/** Open on purpose: an engine may advertise capabilities this contract does not know yet, and clients ignore them. */
export const CapabilityId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export type CapabilityId = z.infer<typeof CapabilityId>;

/**
 * One version of one capability (ADR 0016). Within a version, changes are additive; a breaking change is a new version
 * that an engine advertises next to the old one.
 */
export const CapabilityRef = z.strictObject({ id: CapabilityId, version: z.int().min(1) });
export type CapabilityRef = z.infer<typeof CapabilityRef>;

/** The capability versions this contract defines. */
export const KNOWN_CAPABILITIES = {
    runs: { id: 'runs', version: 1 },
    files: { id: 'files', version: 1 },
    triggers: { id: 'triggers', version: 1 },
    integrations: { id: 'integrations', version: 1 },
    /** Test conversations against an unsaved book; an engine without it simply has no live test chat in the editor. */
    testChat: { id: 'test-chat', version: 1 },
    /**
     * People invited by the organization ask for access with a dashboard ticket and an engine admin approves them; the
     * owner decides whether the dashboard may remove them again. Without it, members join only by invite link.
     */
    accessRequests: { id: 'access-requests', version: 1 },
    /**
     * The engine scans every new file for malware. Without it `FileMetadata.scan` is `null`, a `scan` filter matches
     * nothing, `byScan` counts zero, and the UI shows nothing about scanning.
     */
    fileScanning: { id: 'file-scanning', version: 1 },
    /**
     * Roles, invites, role changes and removals. Without it the engine has one level of access (everyone who can sign
     * in may do everything their permissions say), `GET /members` and `GET /me` still answer, and the UI shows no
     * members screen.
     */
    members: { id: 'members', version: 1 },
    /** API tokens for programmatic access. */
    apiTokens: { id: 'api-tokens', version: 1 },
    /** The hash-chained audit log and its verification. */
    audit: { id: 'audit', version: 1 },
    /**
     * Editing an agent's Book in the UI: saving source, validating a draft and the revision history. Reading the
     * current source (`GET /agents/{agentId}/source`) stays in the core.
     */
    bookEditor: { id: 'book-editor', version: 1 },
    /**
     * Managing agents from forms: changing visibility or folder and restoring a deleted agent. The UI's agent wizard
     * and Settings tab need it; without it agents are created and changed through chat with the engine's own agents.
     */
    agentManagement: { id: 'agent-management', version: 1 },
} as const satisfies Readonly<Record<string, CapabilityRef>>;

export type KnownCapability = (typeof KNOWN_CAPABILITIES)[keyof typeof KNOWN_CAPABILITIES];

/**
 * Designed, not yet specified (docs/engine-integration/live-sessions.md): the names and routes are taken so nothing
 * else claims them, but no engine may advertise them until the design is agreed, and their routes answer 404
 * `capability-not-supported`.
 */
export const RESERVED_CAPABILITIES = {
    /** Full-duplex voice in a chat (capabilities/live.ts). */
    liveAudio: { id: 'live-audio', version: 1 },
    /** Video next to the voice of a `live-audio@1` session; no routes of its own. */
    liveVideo: { id: 'live-video', version: 1 },
    /** The owner drives one engine browser tab to sign in to a site (capabilities/live.ts). */
    browserTab: { id: 'browser-tab', version: 1 },
} as const satisfies Readonly<Record<string, CapabilityRef>>;

/** Whether `ref` is reserved, so its routes are inert on every engine for now. */
export function isReservedCapability(ref: CapabilityRef): boolean {
    return Object.values(RESERVED_CAPABILITIES).some(({ id, version }) => id === ref.id && version === ref.version);
}

/** `runs@1`: how capability versions are written in docs, OpenAPI and messages. */
export function capabilityLabel(ref: CapabilityRef): string {
    return `${ref.id}@${String(ref.version)}`;
}

/** Whether the engine advertises exactly this capability version; unknown IDs and other versions never match. */
export function supports(engineInfo: { readonly capabilities: readonly CapabilityRef[] }, ref: CapabilityRef): boolean {
    return engineInfo.capabilities.some(({ id, version }) => id === ref.id && version === ref.version);
}

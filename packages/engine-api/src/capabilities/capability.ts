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
} as const satisfies Readonly<Record<string, CapabilityRef>>;

export type KnownCapability = (typeof KNOWN_CAPABILITIES)[keyof typeof KNOWN_CAPABILITIES];

/** `runs@1`: how capability versions are written in docs, OpenAPI and messages. */
export function capabilityLabel(ref: CapabilityRef): string {
    return `${ref.id}@${String(ref.version)}`;
}

/** Whether the engine advertises exactly this capability version; unknown IDs and other versions never match. */
export function supports(engineInfo: { readonly capabilities: readonly CapabilityRef[] }, ref: CapabilityRef): boolean {
    return engineInfo.capabilities.some(({ id, version }) => id === ref.id && version === ref.version);
}

import type { OrgId, UserId } from '../ids';
import type { Clock } from '../ports/clock';
import type { OrgRole, PlatformRole } from '../roles';

export const RECOVERY_COOLDOWN_MS = 72 * 60 * 60 * 1000;
export const STEP_UP_WINDOW_MS = 5 * 60 * 1000;

export interface Actor {
    readonly userId: UserId;
    readonly orgId: OrgId;
    readonly orgRole: OrgRole;
    readonly platformRole: PlatformRole;
    /** Milliseconds since the Unix epoch of the last account recovery, or null. */
    readonly recoveredAt: number | null;
    /** Milliseconds since the Unix epoch of the session's last fresh passkey assertion, or null. */
    readonly steppedUpAt: number | null;
}

export type Resource =
    | { readonly kind: 'org'; readonly orgId: OrgId }
    | { readonly kind: 'engine'; readonly orgId: OrgId; readonly engineId: string }
    /** The actor's own account: passkeys, sessions. */
    | { readonly kind: 'account'; readonly userId: UserId }
    | { readonly kind: 'platform' };

export type DenialReason =
    'not-member' | 'not-self' | 'role' | 'recovery-cooldown' | 'platform-admin-only' | 'step-up-required';

export type Decision = { readonly kind: 'allowed' } | { readonly kind: 'denied'; readonly reason: DenialReason };

interface RuleFlags {
    /** Denied for {@link RECOVERY_COOLDOWN_MS} after an account recovery, so a hijacked mailbox cannot do lasting harm at once. */
    readonly sensitive: boolean;
    /** Needs a passkey assertion within {@link STEP_UP_WINDOW_MS} on this session. */
    readonly requiresStepUp: boolean;
}

export type PolicyRule =
    /** On resources of the actor's active organization, for the listed roles. */
    | (RuleFlags & { readonly scope: 'org'; readonly orgRoles: readonly OrgRole[] })
    /** On the actor's own account only. */
    | (RuleFlags & { readonly scope: 'self' })
    /** Platform administrators only, on any resource. */
    | (RuleFlags & { readonly scope: 'platform' });

export type PolicyTable<A extends string> = Readonly<Record<A, PolicyRule>>;

export interface Authorizer<A extends string> {
    can(actor: Actor, action: A, resource: Resource): Decision;
}

const PLATFORM_ADMIN_ROLES: readonly PlatformRole[] = ['admin'];
const ALLOWED: Decision = { kind: 'allowed' };

function denied(reason: DenialReason): Decision {
    return { kind: 'denied', reason };
}

function scopeDecision(actor: Actor, rule: PolicyRule, resource: Resource): Decision {
    switch (rule.scope) {
        case 'platform':
            return PLATFORM_ADMIN_ROLES.includes(actor.platformRole) ? ALLOWED : denied('platform-admin-only');
        case 'self':
            return resource.kind === 'account' && resource.userId === actor.userId ? ALLOWED : denied('not-self');
        case 'org':
            if (resource.kind !== 'org' && resource.kind !== 'engine') {
                return denied('role');
            }
            if (resource.orgId !== actor.orgId) {
                return denied('not-member');
            }
            return rule.orgRoles.includes(actor.orgRole) ? ALLOWED : denied('role');
    }
}

/** Role-derived org permissions, for capability rendering; the cooldown and step-up still apply per request. */
export function orgPermissions<A extends string>(policy: PolicyTable<A>, role: OrgRole): readonly A[] {
    return (Object.keys(policy) as A[]).filter((action) => {
        const rule = policy[action];
        return rule.scope === 'org' && rule.orgRoles.includes(role);
    });
}

export function createAuthorizer<A extends string>(deps: {
    readonly clock: Clock;
    readonly policy: PolicyTable<A>;
}): Authorizer<A> {
    return {
        can(actor, action, resource) {
            // Deny by default, also for a key the type system did not see (e.g. a prototype property).
            const rule: PolicyRule | undefined = Object.hasOwn(deps.policy, action) ? deps.policy[action] : undefined;
            if (rule === undefined) {
                return denied('role');
            }
            const decision = scopeDecision(actor, rule, resource);
            if (decision.kind === 'denied') {
                return decision;
            }
            const now = deps.clock.nowMs();
            if (rule.sensitive && actor.recoveredAt !== null && now - actor.recoveredAt < RECOVERY_COOLDOWN_MS) {
                return denied('recovery-cooldown');
            }
            if (rule.requiresStepUp && (actor.steppedUpAt === null || now - actor.steppedUpAt > STEP_UP_WINDOW_MS)) {
                return denied('step-up-required');
            }
            return ALLOWED;
        },
    };
}

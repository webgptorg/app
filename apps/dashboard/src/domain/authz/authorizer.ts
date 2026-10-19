import type { OrgId, UserId } from '../ids';
import type { Clock } from '../ports/clock';
import type { OrgRole, PlatformRole } from '../roles';

export const RECOVERY_COOLDOWN_MS = 72 * 60 * 60 * 1000;

export interface Actor {
    readonly userId: UserId;
    readonly orgId: OrgId;
    readonly orgRole: OrgRole;
    readonly platformRole: PlatformRole;
    /** Milliseconds since the Unix epoch of the last account recovery, or null. */
    readonly recoveredAt: number | null;
}

export type Resource =
    | { readonly kind: 'org'; readonly orgId: OrgId }
    | { readonly kind: 'engine'; readonly orgId: OrgId; readonly engineId: string }
    | { readonly kind: 'platform' };

export type Decision =
    | { readonly kind: 'allowed' }
    | { readonly kind: 'denied'; readonly reason: 'not-member' | 'role' | 'recovery-cooldown' | 'platform-admin-only' };

export interface PolicyRule {
    /** Org roles that may perform the action on their own organization's resources. */
    readonly orgRoles: readonly OrgRole[];
    readonly platformAdminOnly: boolean;
    /** Denied for {@link RECOVERY_COOLDOWN_MS} after an account recovery, so a hijacked mailbox cannot do lasting harm at once. */
    readonly sensitive: boolean;
}

export type PolicyTable<A extends string> = Readonly<Record<A, PolicyRule>>;

export interface Authorizer<A extends string> {
    can(actor: Actor, action: A, resource: Resource): Decision;
}

const PLATFORM_ADMIN_ROLES: readonly PlatformRole[] = ['admin'];
const ALLOWED: Decision = { kind: 'allowed' };

function denied(reason: Extract<Decision, { kind: 'denied' }>['reason']): Decision {
    return { kind: 'denied', reason };
}

export function createAuthorizer<A extends string>(deps: {
    readonly clock: Clock;
    readonly policy: PolicyTable<A>;
}): Authorizer<A> {
    function scopeDecision(actor: Actor, rule: PolicyRule, resource: Resource): Decision {
        if (rule.platformAdminOnly) {
            return PLATFORM_ADMIN_ROLES.includes(actor.platformRole) ? ALLOWED : denied('platform-admin-only');
        }
        switch (resource.kind) {
            case 'platform':
                return denied('platform-admin-only');
            case 'org':
            case 'engine':
                if (resource.orgId !== actor.orgId) {
                    return denied('not-member');
                }
                return rule.orgRoles.includes(actor.orgRole) ? ALLOWED : denied('role');
        }
    }

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
            if (
                rule.sensitive &&
                actor.recoveredAt !== null &&
                deps.clock.nowMs() - actor.recoveredAt < RECOVERY_COOLDOWN_MS
            ) {
                return denied('recovery-cooldown');
            }
            return ALLOWED;
        },
    };
}

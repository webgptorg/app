import type { Audience } from '../../shared/notifications/notification-kind';
import type { UserId } from '../ids';
import type { Locale } from '../locale';
import type { OrgRole } from '../roles';
import type { MemberAccess } from '../teams/team-store';
import { recipientRoleOf } from './inbox';
import type { NotificationRecipient } from './recipient-directory';

/** A member of the organization as D1 holds them, with their place in the project's team if it has one. */
export interface DirectoryMember {
    readonly userId: UserId;
    readonly email: string;
    readonly emailVerified: boolean;
    readonly locale: Locale;
    readonly orgRole: OrgRole;
    /** Undefined when they are not in the project's team (or there is no project). */
    readonly access: MemberAccess | undefined;
}

export interface DirectoryPerson extends NotificationRecipient {
    /** Sees the project: an org owner or admin, or in its team; everyone for organization-level kinds. */
    readonly sees: boolean;
}

/**
 * ADR 0027's mapping in one place, for every adapter: managers are whoever linked the project and the org owners and
 * admins in its team with approved access (team admins with ADR 0026); never members.
 */
export function directoryPeople(
    members: readonly DirectoryMember[],
    project: { readonly linkerUserId: UserId | null } | null,
): readonly DirectoryPerson[] {
    return members.map((member) => {
        const managesOrg = member.orgRole === 'owner' || member.orgRole === 'admin';
        const approved = member.access === 'approved';
        return {
            userId: member.userId,
            email: member.email,
            emailVerified: member.emailVerified,
            locale: member.locale,
            role: recipientRoleOf(member.orgRole),
            manager: project !== null && (member.userId === project.linkerUserId || (managesOrg && approved)),
            approved,
            sees: project === null || managesOrg || member.access !== undefined,
        };
    });
}

export function inAudience(person: DirectoryPerson, audience: Audience): boolean {
    switch (audience.kind) {
        case 'project-viewers':
            return person.sees;
        case 'project-managers':
            return person.manager;
        case 'org-managers':
            return person.role === 'org-owner' || person.role === 'org-admin';
        case 'person':
            return person.sees && person.userId === audience.userId;
    }
}

export function asRecipient(person: DirectoryPerson): NotificationRecipient {
    return {
        userId: person.userId,
        email: person.email,
        emailVerified: person.emailVerified,
        locale: person.locale,
        role: person.role,
        manager: person.manager,
        approved: person.approved,
    };
}

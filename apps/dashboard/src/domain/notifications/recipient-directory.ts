import type { EngineId } from '@ptbk/protocol';

import type { Audience, NotificationPlace, RecipientRole } from '../../shared/notifications/notification-kind';
import type { OrgId, UserId } from '../ids';
import type { Locale } from '../locale';

export interface NotificationRecipient {
    readonly userId: UserId;
    readonly email: string;
    /** Only verified addresses are ever emailed. */
    readonly emailVerified: boolean;
    readonly locale: Locale;
    readonly role: RecipientRole;
    /** Linked the project, or an owner, admin or team admin in its team with approved access (ADR 0027). */
    readonly manager: boolean;
    /** In the project's team with access the engine approved. */
    readonly approved: boolean;
}

export type ProjectPlace = NotificationPlace & {
    readonly project: (NonNullable<NotificationPlace['project']> & { readonly active: boolean }) | null;
};

/**
 * Who is who to a project, from D1: memberships, teams, approved access and who linked it. The engine is the authority
 * on who is on it; this is only what the dashboard sent there and was told back.
 */
export interface RecipientDirectory {
    /** Everyone the audience names who still sees the project (or the organization); nobody for an unknown project. */
    resolve(
        orgId: OrgId,
        engineId: EngineId | null,
        audience: Audience,
        signal: AbortSignal,
    ): Promise<readonly NotificationRecipient[]>;
    /** One person as they stand now, or null once they no longer see the project (or are out of the organization). */
    member(
        orgId: OrgId,
        engineId: EngineId | null,
        userId: UserId,
        signal: AbortSignal,
    ): Promise<NotificationRecipient | null>;
    /** The organization's name and the project's label and hostname; null for a project not of the organization. */
    place(orgId: OrgId, engineId: EngineId | null, signal: AbortSignal): Promise<ProjectPlace | null>;
    /** The addresses of people the dashboard sent to the project who still wait for approval, issued after `since`. */
    waitingRequesters(engineId: EngineId, since: number, signal: AbortSignal): Promise<readonly string[]>;
}

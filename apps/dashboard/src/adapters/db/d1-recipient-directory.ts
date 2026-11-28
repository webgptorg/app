import type { EngineId } from '@ptbk/protocol';
import { and, asc, desc, eq, gt, isNotNull, isNull } from 'drizzle-orm';

import { userIdSchema, type OrgId, type UserId } from '../../domain/ids';
import { localeSchema } from '../../domain/locale';
import type { ProjectPlace, RecipientDirectory } from '../../domain/notifications/recipient-directory';
import {
    asRecipient,
    directoryPeople,
    inAudience,
    type DirectoryMember,
    type DirectoryPerson,
} from '../../domain/notifications/recipient-rules';
import { orgRoleSchema } from '../../domain/roles';
import { projectName } from '../../shared/engine-label';
import { z } from 'zod';

import type { Database } from './client';
import { accessTickets, engines, linkCodes, memberships, organizations, teamMembers, teams, users } from './schema';

const memberAccessSchema = z.enum(['none', 'waiting', 'approved']);

/** An email lists at most this many waiting people; the Members page lists them all. */
const MAX_REQUESTERS = 20;

/**
 * See {@link RecipientDirectory}. Organizations are small, so it reads the organization's people once per call and
 * leaves the decisions to `recipient-rules.ts`, where ADR 0027's mapping lives for every adapter.
 */
export function createD1RecipientDirectory(db: Database): RecipientDirectory {
    async function people(orgId: OrgId, engineId: EngineId | null): Promise<readonly DirectoryPerson[] | null> {
        const members = await db
            .select({
                userId: users.id,
                email: users.email,
                emailVerifiedAt: users.emailVerifiedAt,
                locale: users.locale,
                role: memberships.role,
            })
            .from(memberships)
            .innerJoin(users, eq(users.id, memberships.userId))
            .where(eq(memberships.orgId, orgId))
            .orderBy(asc(users.email))
            .all();
        let team = new Map<string, string>();
        let linker: string | null = null;
        if (engineId !== null) {
            const engine = await db
                .select({ teamId: engines.teamId })
                .from(engines)
                .where(and(eq(engines.engineId, engineId), eq(engines.orgId, orgId)))
                .get();
            if (engine === undefined) {
                return null;
            }
            if (engine.teamId !== null) {
                const rows = await db
                    .select({ userId: teamMembers.userId, access: teamMembers.access })
                    .from(teamMembers)
                    .where(eq(teamMembers.teamId, engine.teamId))
                    .all();
                team = new Map(rows.map((row) => [row.userId, row.access]));
            }
            const link = await db
                .select({ userId: linkCodes.createdByUserId })
                .from(linkCodes)
                .where(and(eq(linkCodes.engineId, engineId), eq(linkCodes.orgId, orgId), isNotNull(linkCodes.usedAt)))
                .orderBy(desc(linkCodes.usedAt))
                .get();
            linker = link?.userId ?? null;
        }
        return directoryPeople(
            members.flatMap((member): DirectoryMember[] => {
                const role = orgRoleSchema.safeParse(member.role);
                const access = team.get(member.userId);
                return role.success
                    ? [
                          {
                              userId: userIdSchema.parse(member.userId),
                              email: member.email,
                              emailVerified: member.emailVerifiedAt !== null,
                              locale: localeSchema.catch('en').parse(member.locale),
                              orgRole: role.data,
                              access: access === undefined ? undefined : memberAccessSchema.parse(access),
                          },
                      ]
                    : [];
            }),
            engineId === null ? null : { linkerUserId: linker === null ? null : userIdSchema.parse(linker) },
        );
    }

    return {
        async resolve(orgId, engineId, audience) {
            const everyone = await people(orgId, engineId);
            return (everyone ?? []).filter((person) => inAudience(person, audience)).map(asRecipient);
        },

        async member(orgId, engineId, userId: UserId) {
            const person = (await people(orgId, engineId))?.find((candidate) => candidate.userId === userId);
            return person?.sees === true ? asRecipient(person) : null;
        },

        async place(orgId, engineId): Promise<ProjectPlace | null> {
            const org = await db
                .select({ name: organizations.name })
                .from(organizations)
                .where(eq(organizations.id, orgId))
                .get();
            if (org === undefined) {
                return null;
            }
            if (engineId === null) {
                return { orgName: org.name, project: null };
            }
            const engine = await db
                .select({
                    engineId: engines.engineId,
                    hostname: engines.hostname,
                    label: engines.label,
                    status: engines.status,
                    teamName: teams.name,
                })
                .from(engines)
                .leftJoin(teams, and(eq(teams.id, engines.teamId), isNull(teams.deletedAt)))
                .where(and(eq(engines.engineId, engineId), eq(engines.orgId, orgId)))
                .get();
            if (engine === undefined) {
                return null;
            }
            return {
                orgName: org.name,
                project: { label: projectName(engine), hostname: engine.hostname, active: engine.status === 'active' },
            };
        },

        async waitingRequesters(engineId, since) {
            const rows = await db
                .selectDistinct({ email: users.email })
                .from(accessTickets)
                .innerJoin(users, eq(users.id, accessTickets.userId))
                .where(
                    and(
                        eq(accessTickets.engineId, engineId),
                        isNull(accessTickets.outcome),
                        isNotNull(accessTickets.noticedAt),
                        gt(accessTickets.issuedAt, since),
                    ),
                )
                .orderBy(asc(users.email))
                .limit(MAX_REQUESTERS)
                .all();
            return rows.map((row) => row.email);
        },
    };
}

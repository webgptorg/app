import type { EngineId } from '@ptbk/protocol';

import type { OrgId, UserId } from '../domain/ids';
import type { Locale } from '../domain/locale';
import type { ProjectPlace, RecipientDirectory } from '../domain/notifications/recipient-directory';
import {
    asRecipient,
    directoryPeople,
    inAudience,
    type DirectoryMember,
} from '../domain/notifications/recipient-rules';
import type { OrgRole } from '../domain/roles';
import type { MemberAccess } from '../domain/teams/team-store';

export interface FakePerson {
    readonly userId: UserId;
    readonly email: string;
    readonly orgRole: OrgRole;
    readonly emailVerified?: boolean;
    readonly locale?: Locale;
    /** Their access per project whose team they are in. */
    readonly projects?: Readonly<Record<string, MemberAccess>>;
}

export interface FakeRecipientDirectory extends RecipientDirectory {
    setPeople(orgId: OrgId, people: readonly FakePerson[]): void;
    setProject(
        orgId: OrgId,
        engineId: EngineId,
        project: {
            readonly label: string;
            readonly hostname: string;
            readonly active?: boolean;
            readonly linker?: UserId;
        },
    ): void;
    setOrgName(orgId: OrgId, name: string | null): void;
    setRequesters(engineId: EngineId, emails: readonly string[]): void;
    /** Every call fails from now on, like an unreachable D1. */
    fail(): void;
}

/** The directory's rules over hand-made people, for unit tests. */
export function createFakeRecipientDirectory(): FakeRecipientDirectory {
    const people = new Map<OrgId, readonly FakePerson[]>();
    const projects = new Map<string, { label: string; hostname: string; active: boolean; linker: UserId | null }>();
    const orgNames = new Map<OrgId, string | null>();
    const requesters = new Map<EngineId, readonly string[]>();
    let failing = false;
    const check = () => (failing ? Promise.reject(new Error('directory unavailable')) : Promise.resolve());
    const everyone = (orgId: OrgId, engineId: EngineId | null) => {
        const project = engineId === null ? undefined : projects.get(`${orgId}|${engineId}`);
        if (engineId !== null && project === undefined) {
            return null;
        }
        const members = (people.get(orgId) ?? []).map((person): DirectoryMember => ({
            userId: person.userId,
            email: person.email,
            emailVerified: person.emailVerified ?? true,
            locale: person.locale ?? 'en',
            orgRole: person.orgRole,
            access: engineId === null ? undefined : person.projects?.[engineId],
        }));
        return directoryPeople(members, project === undefined ? null : { linkerUserId: project.linker });
    };
    return {
        setPeople: (orgId, list) => people.set(orgId, list),
        setProject: (orgId, engineId, project) =>
            projects.set(`${orgId}|${engineId}`, {
                label: project.label,
                hostname: project.hostname,
                active: project.active ?? true,
                linker: project.linker ?? null,
            }),
        setOrgName: (orgId, name) => orgNames.set(orgId, name),
        setRequesters: (engineId, emails) => requesters.set(engineId, emails),
        fail: () => {
            failing = true;
        },
        async resolve(orgId, engineId, audience) {
            await check();
            return (everyone(orgId, engineId) ?? []).filter((person) => inAudience(person, audience)).map(asRecipient);
        },
        async member(orgId, engineId, userId) {
            await check();
            const person = everyone(orgId, engineId)?.find((candidate) => candidate.userId === userId);
            return person?.sees === true ? asRecipient(person) : null;
        },
        async place(orgId, engineId): Promise<ProjectPlace | null> {
            await check();
            const orgName = orgNames.get(orgId) ?? null;
            if (engineId === null) {
                return { orgName, project: null };
            }
            const project = projects.get(`${orgId}|${engineId}`);
            return project === undefined
                ? null
                : { orgName, project: { label: project.label, hostname: project.hostname, active: project.active } };
        },
        async waitingRequesters(engineId) {
            await check();
            return requesters.get(engineId) ?? [];
        },
    };
}

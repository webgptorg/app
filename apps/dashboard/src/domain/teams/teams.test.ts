import { describe, expect, it } from 'vitest';

import { createTestEngine } from '../../testing/test-engine';
import { teamNameSchema } from '../../shared/team-name';
import { orgIdSchema, teamIdSchema, userIdSchema } from '../ids';
import type { TeamStore } from './team-store';
import { deleteTeam } from './teams';

const ORG = orgIdSchema.parse('aaaaaaaaaaaaaaaaaaaaaaaaaa');
const TEAM = teamIdSchema.parse('tttttttttttttttttttttttttt');
const OWNER = { orgId: ORG, userId: userIdSchema.parse('uuuuuuuuuuuuuuuuuuuuuuuuuu'), orgRole: 'owner' } as const;

describe('deleteTeam', () => {
    it('names no removed engine when another request deleted the team first', async () => {
        const engine = await createTestEngine();
        const revoked: string[] = [];
        const teams = {
            find: () =>
                Promise.resolve({
                    id: TEAM,
                    orgId: ORG,
                    name: teamNameSchema.parse('Client A'),
                    createdAt: 0,
                    engineId: engine.engineId,
                    memberCount: 1,
                }),
            delete: () => Promise.resolve('not-found' as const),
        } as unknown as TeamStore;
        const deps = {
            teams,
            engines: {
                revoke: (_orgId: unknown, engineId: string) => {
                    revoked.push(engineId);
                    return Promise.resolve('already-revoked' as const);
                },
            },
            clock: { nowMs: () => 0 },
            random: { bytes: (length: number) => new Uint8Array(length) },
            logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        };
        expect(await deleteTeam(deps, OWNER, TEAM)).toEqual({ kind: 'not-found' });
        expect(revoked).toEqual([engine.engineId]);
    });
});

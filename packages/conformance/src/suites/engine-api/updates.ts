import { ENGINE_API_ROUTES, KNOWN_CAPABILITIES, MAX_UI_CHECK_INTERVAL_MS, OWNER_PERMISSIONS } from '@ptbk/engine-api';

import type { ConformanceCheck } from '../../check';
import { Findings, fail, skip } from '../../check';
import { describe } from './api';
import { requireCapability } from './capability-support';
import { SUITE, attempt } from './support';
import { allPermissionsExcept, createWorld, sessionFor } from './world';

const R = ENGINE_API_ROUTES;
const UPDATES = KNOWN_CAPABILITIES.updates;
/** Timestamps have second precision, and the engine stamps a check a moment after it started. */
const SLACK_MS = 2_000;
/**
 * How late a due check may be reported while it runs. More than this is the timer bug the capability exists to show
 * (2026-11-24: a demo engine's periodic check never fired for 15 hours).
 */
const LATE_MS = 5 * 60_000;

const floorToSecond = (ms: number): number => Math.floor(ms / 1000) * 1000;

export const UPDATES_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.updates.permissions',
        suite: SUITE,
        title: 'A member without settings.manage cannot run the UI update check: 403, and no check runs',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, UPDATES);
            const member = await sessionFor(
                ctx,
                { kind: 'member', permissions: allPermissionsExcept('settings.manage', OWNER_PERMISSIONS) },
                'a member without settings.manage',
            );
            const findings = new Findings();
            const before = (await world.owner.ok(R.getSecurityOverview)).ui.lastUpdateCheck;
            await attempt(findings, async () => {
                await member.problem(R.checkForUiUpdate, {}, 'forbidden');
            });
            const after = (await world.owner.ok(R.getSecurityOverview)).ui.lastUpdateCheck;
            if (after !== null && after.at !== before?.at) {
                findings.add(`${describe(R.checkForUiUpdate)}: a refused request ran a check (at ${after.at})`);
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.updates.check-now',
        suite: SUITE,
        title: 'Check-now runs one check and reports it in GET /security; a second within a minute is 429 update-check-too-soon',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, UPDATES);
            const findings = new Findings();
            const where = describe(R.checkForUiUpdate);
            const startedAt = floorToSecond(Date.now());
            const first = await world.owner.call(R.checkForUiUpdate);
            if (first.kind === 'problem' && first.problem.code === 'update-policy-manual') {
                const { ui } = await world.owner.ok(R.getSecurityOverview);
                if (ui.nextCheckAt !== null) {
                    findings.add(
                        `${where}: refused as manual, yet GET /security schedules a check at ${ui.nextCheckAt}`,
                    );
                }
                return findings.outcome();
            }
            if (first.kind === 'problem' && first.problem.code !== 'update-check-too-soon') {
                findings.add(`${where}: expected a check or 429 update-check-too-soon, got ${first.problem.code}`);
            }
            if (first.kind === 'ok') {
                const check = first.data;
                if (Date.parse(check.at) < startedAt - SLACK_MS) {
                    findings.add(`${where}: answered a check from ${check.at}, before the request`);
                }
                const reported = (await world.owner.ok(R.getSecurityOverview)).ui.lastUpdateCheck;
                if (reported === null || reported.at !== check.at || reported.outcome !== check.outcome) {
                    findings.add(`${where}: GET /security does not report the check it answered`);
                }
            }
            await attempt(findings, async () => {
                await world.owner.problem(R.checkForUiUpdate, {}, 'update-check-too-soon');
            });
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.updates.next-check-due',
        suite: SUITE,
        title: 'GET /security reports the next UI check at most an hour after the last one, and not long overdue',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, UPDATES);
            const { ui } = await world.owner.ok(R.getSecurityOverview);
            const last = ui.lastUpdateCheck;
            // No check yet means the loader is off (no trust policy); under `manual` nothing is scheduled.
            if (last === null) skip('no-ui-update-check');
            if (ui.nextCheckAt === null) {
                const answer = await world.owner.call(R.checkForUiUpdate);
                if (answer.kind === 'problem' && answer.problem.code === 'update-policy-manual') skip('policy-manual');
                fail('ui.nextCheckAt is null although the loader checked and the policy is not manual');
            }
            const findings = new Findings();
            const next = Date.parse(ui.nextCheckAt);
            const latest = Date.parse(last.at) + MAX_UI_CHECK_INTERVAL_MS + SLACK_MS;
            if (next > latest) {
                findings.add(`ui.nextCheckAt ${ui.nextCheckAt} is more than an hour after the last check (${last.at})`);
            }
            if (next < Date.now() - LATE_MS) {
                findings.add(`ui.nextCheckAt ${ui.nextCheckAt} is long past: the scheduled check did not run`);
            }
            return findings.outcome();
        },
    },
];

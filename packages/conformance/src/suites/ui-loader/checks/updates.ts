import { ENGINE_API_ROUTES, KNOWN_CAPABILITIES, MAX_UI_CHECK_INTERVAL_MS, supports } from '@ptbk/engine-api';

import { Findings, skip } from '../../../check';
import { describeCheck } from '../bench';
import type { UiLoaderCheck } from './common';
import { expectStillActive } from './common';

const R = ENGINE_API_ROUTES;
const SLACK_MS = 2_000;

export const checkNowRespectsDelay: UiLoaderCheck = {
    id: 'ui-loader.updates.check-now-respects-delay',
    title: 'Under auto, check-now (updates@1) refuses a release inside its delay with eligibleAt, keeps the current bundle, and the next check stays within the hour',
    async run(bench, ctx) {
        const findings = new Findings();
        const baseline = await bench.baseline(ctx);
        await bench.revocations();
        const published = await bench.publish(bench.nextVersion());
        bench.setLatest(published.version);
        const startup = await bench.auto(ctx);
        const owner = bench.owner(ctx);
        if (!supports(await owner.ok(R.getEngine), KNOWN_CAPABILITIES.updates)) skip('capability-not-advertised');
        const label = `check-now of ${published.version} published just now`;
        const answer = await owner.call(R.checkForUiUpdate);
        if (answer.kind === 'problem') {
            findings.add(`${label}: expected a check, got ${String(answer.status)} ${answer.problem.code}`);
        } else {
            const check = answer.data;
            if (
                check.outcome !== 'refused' ||
                check.reason !== 'delay-not-elapsed' ||
                check.version !== published.version
            ) {
                findings.add(
                    `${label}: expected refused ${published.version} delay-not-elapsed, got ${describeCheck(check)}`,
                );
            } else if (check.eligibleAt === null) {
                findings.add(`${label}: no eligibleAt`);
            } else if (
                startup.check.eligibleAt !== null &&
                Date.parse(check.eligibleAt) < Date.parse(startup.check.eligibleAt) - SLACK_MS
            ) {
                findings.add(
                    `${label}: eligible at ${check.eligibleAt}, earlier than the startup check said (${startup.check.eligibleAt})`,
                );
            }
        }
        const { ui } = await bench.security(ctx);
        await expectStillActive(bench, ctx, findings, label, baseline, {
            check: ui.lastUpdateCheck ?? startup.check,
            ui,
        });
        if (ui.nextCheckAt === null) findings.add(`${label}: ui.nextCheckAt is null under auto`);
        else if (Date.parse(ui.nextCheckAt) > Date.now() + MAX_UI_CHECK_INTERVAL_MS + SLACK_MS) {
            findings.add(
                `${label}: the next check (${ui.nextCheckAt}) is more than an hour away while a release waits`,
            );
        }
        return findings.outcome();
    },
};

import { describe, expect, it } from 'vitest';

import { fakeEngineCommand } from '../testing/engines';
import { notPassing, run } from '../testing/self-test';

describe('the registration and heartbeat suites', () => {
    // Each defect breaks one rule; every check must fail for the defect it exists to catch.
    it.each([
        [['bad-registration-signature'], 'registration.request.signature-verifies', 'sig does not verify'],
        [['wrong-mode'], 'registration.request.signature-verifies', 'mode is direct'],
        [['oversized-registration'], 'registration.request.signature-verifies', 'over 4096'],
        [['no-signature-header'], 'heartbeat.signature.verifies', 'Ptbk-Signature header is missing'],
        [['garbage-heartbeat-body'], 'heartbeat.body.strict', 'not a strict Heartbeat: (body)'],
        [['garbage-heartbeat-body'], 'heartbeat.seq.increasing-across-restarts', 'seq did not increase'],
        [['slow-heartbeat'], 'heartbeat.cadence.interval', 'the next beat came only after'],
        [['heartbeat-wrong-engine-id'], 'registration.identity.engine-id-derived', 'path names another engine ID'],
        [['ephemeral-key'], 'registration.identity.stable-across-restarts', 'registered another public key'],
        [['register-every-start'], 'registration.link-code.used-once', 'sent 2 times'],
        [['log-link-code'], 'registration.secrets.never-logged', 'output contains the link code'],
        [['log-private-key'], 'registration.secrets.never-logged', 'output contains the engine key'],
        [['store-link-code'], 'registration.secrets.never-logged', 'registration.json under PTBK_DATA_DIR'],
        [['strict-response'], 'registration.response.unknown-fields-ignored', 'exited (status 1)'],
        [['accept-any-response'], 'registration.response.invalid-refused', 'the engine sent heartbeats'],
        [['retry-loop'], 'registration.errors.rate-limited', 'a retry loop'],
        [['retry-loop'], 'registration.errors.engine-exists', 'engine-exists is final'],
        [['silent-errors'], 'registration.errors.not-entitled', 'does not name the problem code not-entitled'],
        [['loose-data-dir', 'no-permission-check'], 'registration.data-dir.private', 'has mode 755'],
        [['symlinked-data-dir', 'no-permission-check'], 'registration.data-dir.private', 'is a symbolic link'],
        [['loose-key-file', 'no-permission-check'], 'registration.key-file.private', 'has mode 644'],
        [['no-permission-check'], 'registration.key-file.loose-modes-refused', 'the engine kept running'],
        [
            ['refuse-with-status-0'],
            'registration.key-file.loose-modes-refused',
            'exited with status 0, not a failure status',
        ],
        [['ephemeral-key'], 'registration.key-file.private', 'no file under PTBK_DATA_DIR holds the registered key'],
        [['bad-heartbeat-signature'], 'heartbeat.signature.verifies', 'does not verify over'],
        [['heartbeat-wrong-engine-id'], 'heartbeat.signature.verifies', 'path does not name the engine ID'],
        [['extra-heartbeat-field'], 'heartbeat.body.strict', 'not a strict Heartbeat'],
        [['unrounded-percent'], 'heartbeat.body.strict', 'diskPct'],
        [['oversized-heartbeat'], 'heartbeat.body.strict', 'over 4096'],
        [['skewed-clock'], 'heartbeat.body.strict', 'ts is more than 120 s'],
        [['wrong-heartbeat-version'], 'heartbeat.body.strict', 'version is not the registered engineVersion'],
        [['garbage-heartbeat-body'], 'registration.identity.engine-id-derived', "body's engineId is not"],
        [['seq-from-zero'], 'heartbeat.seq.increasing-across-restarts', 'did not increase across the restart'],
        [['retry-failed-beat'], 'heartbeat.cadence.interval', 'after a 503, the next beat came after'],
        [['retry-failed-beat'], 'heartbeat.errors.keeps-sending', 'before the next tick'],
        [['stop-on-error'], 'heartbeat.errors.keeps-sending', 'exited'],
    ])('%j fails %s', async (defects, id, expected) => {
        const [result] = await run(fakeEngineCommand(...defects), [id]);
        expect(result?.outcome.kind === 'fail' ? result.outcome.detail : result?.outcome).toContain(expected);
    });

    it('fail, each with its own reason, for an engine that exits at once', async () => {
        const failed = notPassing(await run({ command: 'echo broken >&2; exit 1', cwd: process.cwd() }));
        expect(Object.keys(failed)).toHaveLength(22);
        for (const [id, outcome] of Object.entries(failed)) {
            if (id !== 'heartbeat.stale-ts.skew-shown') expect(outcome).toMatch(/^fail: .*exited \(status 1\)/);
        }
    });

    it('fail for an engine that registers but never sends a heartbeat', async () => {
        // Nothing will arrive, so the waits are as short as they can be.
        const failed = notPassing(
            await run(fakeEngineCommand('no-heartbeat'), undefined, {
                heartbeatIntervalMs: 500,
                startTimeoutMs: 1000,
                quietWindowMs: 500,
            }),
        );
        expect(Object.keys(failed).length).toBeGreaterThan(15);
    }, 180_000);
});

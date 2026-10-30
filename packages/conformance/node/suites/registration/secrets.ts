import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';

import { Findings } from '../../../src/index';
import type { PlatformCheck } from '../../harness/platform';
import { attemptWait, findEngineKey, regularFiles, secretForms, startLinkedEngine } from '../support';
import { SUITE } from './request';

export const secretsNeverLogged: PlatformCheck = {
    id: 'registration.secrets.never-logged',
    suite: SUITE,
    title: 'Neither the link code nor the engine key appears in the engine output, and the link code is in no file under PTBK_DATA_DIR',
    timeoutMs: (expectations) => expectations.startTimeoutMs * 3 + expectations.heartbeatIntervalMs * 2,
    async run(ctx) {
        const linked = await startLinkedEngine(ctx);
        const window = ctx.expectations.startTimeoutMs + ctx.expectations.heartbeatIntervalMs;
        const first = await attemptWait(
            ctx,
            linked,
            'send an accepted heartbeat',
            () => linked.dashboard.heartbeats.find((beat) => beat.answer.status < 300),
            window,
        );
        if (!first.ok) return { kind: 'fail', detail: first.reason };
        // A second start logs its startup with a stored registration, which is where a key or code would leak again.
        const restartedAt = Date.now();
        await linked.engine.restart();
        await attemptWait(
            ctx,
            linked,
            'send an accepted heartbeat after the restart',
            () => linked.dashboard.heartbeats.find((beat) => beat.at >= restartedAt && beat.answer.status < 300),
            window,
        );
        await linked.engine.stop();

        const findings = new Findings();
        const output = linked.engine.logs();
        if (secretForms(linked.linkCode).some((form) => output.includes(form))) {
            findings.add('the engine output contains the link code');
        }
        const publicKey = linked.dashboard.registrations.find((entry) => entry.request !== null)?.request
            ?.enginePublicKey;
        const key = publicKey === undefined ? null : await findEngineKey(linked.engine.dataDir, publicKey);
        if (key !== null) {
            const forms = [...secretForms(key.seed), ...secretForms(key.pkcs8)];
            if (forms.some((form) => output.includes(form))) findings.add('the engine output contains the engine key');
        }
        const codeForms = secretForms(linked.linkCode).map((form) => Buffer.from(form));
        for (const path of await regularFiles(linked.engine.dataDir)) {
            const content = await readFile(path);
            if (codeForms.some((form) => content.includes(form))) {
                findings.add(`${relative(linked.engine.dataDir, path)} under PTBK_DATA_DIR contains the link code`);
            }
        }
        return findings.outcome();
    },
};

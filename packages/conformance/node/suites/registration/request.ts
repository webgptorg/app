import { REGISTER_REQUEST_MAX_BYTES } from '@ptbk/protocol';

import { Findings } from '../../../src/index';
import { startFakeDashboard, waitWhileRunning } from '../../fakes/dashboard';
import type { PlatformCheck } from '../../harness/platform';

export const SUITE = 'registration';

export const signatureVerifies: PlatformCheck = {
    id: 'registration.request.signature-verifies',
    suite: SUITE,
    title: 'The registration request is a strict RegisterEngineRequest with the link code and mode tunnel, and its signature verifies',
    async run(ctx) {
        const dashboard = ctx.use(await startFakeDashboard(ctx));
        const linkCode = dashboard.issueLinkCode();
        const engine = await ctx.engine({ env: { ...dashboard.env, PTBK_LINK_CODE: linkCode } });
        await engine.start();
        const first = await waitWhileRunning(ctx, engine, dashboard, 'send a registration request', () =>
            dashboard.registrations.at(0),
        );
        const findings = new Findings();
        if (first.rawBody.length > REGISTER_REQUEST_MAX_BYTES) {
            findings.add(
                `the request has ${String(first.rawBody.length)} bytes, over ${String(REGISTER_REQUEST_MAX_BYTES)}`,
            );
        }
        const { request } = first;
        if (request === null) {
            findings.add('the body is not JSON that parses with the strict RegisterEngineRequest schema');
            return findings.outcome();
        }
        if (request.linkCode !== linkCode) findings.add('linkCode is not the PTBK_LINK_CODE the engine was given');
        if (request.mode !== 'tunnel') findings.add(`mode is ${request.mode}, not tunnel (PTBK_MODE)`);
        if (!first.signatureValid) {
            findings.add(
                "sig does not verify over signingInput('ptbk-register-v1', v, linkCode, public key, engineVersion, mode)",
            );
        }
        return findings.outcome();
    },
};

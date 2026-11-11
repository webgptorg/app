import type { ReadSecurityOverview } from '@ptbk/engine-api';
import { SIGN_IN_PATH } from '@ptbk/engine-api';
import { EngineVersion } from '@ptbk/protocol';

import type { Fetched } from './bounded-get';
import type { StagingContext } from './context';
import { createStagingContext } from './context';
import { SETUP_FIX, SETUP_PATH, SIGN_IN_FIX, checkAnonymous, checkCsp, checkPage } from './gateway';
import { evaluateDns, evaluateTls } from './network';
import type { JsonRead } from './session';
import { ENGINE_PATH, SECURITY_PATH, checkEngineInfo, readSecurity } from './session';
import { checkUiRelease } from './ui-release';
import { checkUiServed } from './ui-served';
import type { StagingCheckId, StagingOptions, StagingPorts, StagingReport, StagingResult } from './types';
import { STAGING_CHECK_IDS } from './types';

const UNREACHABLE: readonly StagingCheckId[] = [
    'staging.gateway.sign-in',
    'staging.gateway.setup',
    'staging.gateway.anonymous',
    'staging.headers.csp',
    'staging.engine.info',
    'staging.ui.served',
];

/**
 * Checks from outside what the platform promises for one engine on live staging. Read-only: DNS lookups, TLS
 * handshakes and `GET`s, each with its own timeout. Without a TLS connection the public roots accept, the HTTP checks
 * skip (Node's fetch would refuse it too); without an owner cookie, the session checks skip.
 */
export async function runStagingCheck(options: StagingOptions, ports: StagingPorts): Promise<StagingReport> {
    const ctx = createStagingContext(options, ports);
    const hostname = options.engine.hostname;
    const deadline = (): AbortSignal => AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]);
    const results = new Map<StagingCheckId, StagingResult>();
    const add = (result: StagingResult): void => {
        results.set(result.id, result);
    };

    const [engineAnswer, relayAnswers] = await Promise.all([
        ports.lookup(hostname, deadline()),
        Promise.all(
            options.relays.map(async (relay) => ({ hostname: relay, answer: await ports.lookup(relay, deadline()) })),
        ),
    ]);
    add(evaluateDns(hostname, engineAnswer, relayAnswers));
    const tls = evaluateTls(hostname, await ports.probeTls(hostname, deadline()), ports.nowMs());
    add(tls.result);

    let engineVersion: EngineVersion | null = null;
    let session: SessionAnswers | null = null;
    if (tls.reachable) {
        const signIn = await ctx.engineGet(SIGN_IN_PATH, 'document', false);
        add(checkPage('staging.gateway.sign-in', SIGN_IN_PATH, signIn, SIGN_IN_FIX));
        add(
            checkPage(
                'staging.gateway.setup',
                SETUP_PATH,
                await ctx.engineGet(SETUP_PATH, 'document', false),
                SETUP_FIX,
            ),
        );
        const anonymousRoot = await ctx.engineGet('/', 'document', false);
        add(checkAnonymous(options.engine, anonymousRoot, await ctx.engineGet(ENGINE_PATH, 'api', false)));
        session = ctx.hasSession ? await sessionAnswers(ctx) : null;
        add(checkCsp(signIn, session?.root ?? null));
        add(checkEngineInfo(session?.engine ?? null, hostname, options.engineId));
        if (session?.security.kind === 'ok') {
            const reported = EngineVersion.safeParse(session.security.value.ui.version);
            if (reported.success) engineVersion = reported.data;
        }
    } else {
        for (const id of UNREACHABLE) {
            add({
                id,
                status: 'skip',
                detail: `needs a TLS connection to ${hostname} that public roots trust`,
                fix: 'fix staging.tls.public-certificate first',
            });
        }
    }

    const release = await checkUiRelease(ctx, engineVersion);
    add(release.result);
    if (tls.reachable) {
        add(await checkUiServed(ctx, session?.root ?? null, session?.security ?? null, release.release));
    }

    const checks = STAGING_CHECK_IDS.flatMap((id) => {
        const result = results.get(id);
        return result === undefined ? [] : [result];
    });
    return { engine: options.engine.origin, ok: checks.every(({ status }) => status !== 'fail'), checks };
}

interface SessionAnswers {
    readonly root: Fetched;
    readonly engine: Fetched;
    readonly security: JsonRead<ReadSecurityOverview>;
}

async function sessionAnswers(ctx: StagingContext): Promise<SessionAnswers> {
    const root = await ctx.engineGet('/', 'document', true);
    const engine = await ctx.engineGet(ENGINE_PATH, 'api', true);
    const security = readSecurity(await ctx.engineGet(SECURITY_PATH, 'api', true));
    return { root, engine, security };
}

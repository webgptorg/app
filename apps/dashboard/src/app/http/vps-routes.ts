import { generateLinkCode } from '@ptbk/protocol';
import type { Hono } from 'hono';
import { sha256Hex } from '../../domain/auth/secrets';
import { linkCodeIdSchema } from '../../domain/ids';
import type { EngineCreationPolicy } from '../../domain/registration/engine-creation-policy';
import { apiRoutes } from '../../shared/api/routes';
import type { DashboardDeps } from '../deps';
import type { RouteBinder } from './bind-route';

export function bindVpsRoutes(
    router: Hono,
    mount: string,
    deps: DashboardDeps & { policy: EngineCreationPolicy; routes: RouteBinder },
) {
    const releaseFor = async (signal: AbortSignal) => {
        const fallback = deps.config.engineInstallation;
        return fallback && deps.config.dashboardOrigin.startsWith('https://')
            ? await deps.installReleases.current(fallback, signal)
            : undefined;
    };
    deps.routes.bind(router, mount, apiRoutes.getVpsLaunch, async ({ input, request, session }) => {
        const id = linkCodeIdSchema.parse(input.params.linkCodeId);
        const org = session.actor.orgId;
        const state = await deps.linkCodes.findState(org, id, deps.clock.nowMs());
        if (!state) return { kind: 'problem', status: 404, code: 'not-found' };
        const reservation = await deps.linkCodes.vpsStatus(org, id);
        const available =
            !reservation && state.kind === 'pending' && (await releaseFor(request.signal))?.digitalOceanOwner;
        const offer = available
            ? { provider: 'digitalocean' as const, referralUrl: deps.config.digitalOcean?.referralUrl }
            : null;
        return { kind: 'ok', body: { reservation, offer } };
    });
    deps.routes.bind(router, mount, apiRoutes.authorizeVps, async ({ input, request, session }) => {
        const id = linkCodeIdSchema.parse(input.params.linkCodeId);
        const org = session.actor.orgId;
        const state = await deps.linkCodes.findState(org, id, deps.clock.nowMs());
        if (!state) return { kind: 'problem', status: 404, code: 'not-found' };
        const provider = deps.vpsProviders?.[input.body.provider];
        if (
            !provider ||
            state.kind !== 'pending' ||
            (await deps.linkCodes.vpsStatus(org, id)) ||
            !(await releaseFor(request.signal))?.digitalOceanOwner
        )
            return { kind: 'problem', status: 409, code: 'vps-unavailable' };
        return { kind: 'ok', body: { clientId: await provider.clientId(request.signal) } };
    });
    deps.routes.bind(router, mount, apiRoutes.launchVps, async ({ input, session, request }) => {
        const { orgId, userId } = session.actor;
        const id = linkCodeIdSchema.parse(input.params.linkCodeId);
        const state = await deps.linkCodes.findState(orgId, id, deps.clock.nowMs());
        if (!state) return { kind: 'problem', status: 404, code: 'not-found' };
        const submitted = { kind: 'ok', body: { submitted: true } } as const;
        if (await deps.linkCodes.vpsStatus(orgId, id)) return submitted;
        if (state.kind !== 'pending') return { kind: 'problem', status: 409, code: 'vps-unavailable' };
        const eligibility = await deps.policy.checkEligibility(orgId, request.signal);
        if (eligibility.kind === 'denied') return { kind: 'problem', status: 403, code: eligibility.reason };
        const provider = deps.vpsProviders?.[input.body.provider];
        const release = await releaseFor(request.signal);
        if (!provider || !release?.digitalOceanOwner) return { kind: 'problem', status: 409, code: 'vps-unavailable' };
        const grant = await provider.authorize(input.body.code, input.body.verifier, request.signal).catch(() => null);
        if (!grant) return { kind: 'problem', status: 403, code: 'provider-rejected' };
        try {
            if (!(await provider.checkPrice(grant, request.signal)))
                return { kind: 'problem', status: 409, code: 'vps-unavailable' };
            const code = generateLinkCode({ bytes: (n) => new Uint8Array(deps.random.bytes(n)) });
            const userData = provider.bootstrap(release, code, grant);
            const reservation = {
                orgId,
                userId,
                id,
                now: deps.clock.nowMs(),
                codeHash: await sha256Hex(code),
                provider: input.body.provider,
            };
            if (!(await deps.linkCodes.reserveVps(reservation))) {
                return (await deps.linkCodes.vpsStatus(orgId, id))
                    ? submitted
                    : { kind: 'problem', status: 409, code: 'vps-unavailable' };
            }
            const result = await provider.create(grant, 'promptbook-' + id, userData);
            if (result.kind === 'rejected') {
                await deps.linkCodes.finishVps(reservation, null);
                return { kind: 'problem', status: 409, code: 'provider-rejected' };
            }
            if (result.kind === 'created') await deps.linkCodes.finishVps(reservation, result.resourceId);
            return submitted;
        } finally {
            request.waitUntil(provider.revoke(grant).catch(() => undefined));
        }
    });
}

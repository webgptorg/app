import { Hostname, type LinkCode, type RegisterEngineRequest } from '@ptbk/protocol';

import { cryptoRandom } from '../adapters/crypto-random';
import { createFakeClock } from '../adapters/fake-clock';
import { createMemoryLogger } from '../adapters/memory-logger';
import { sha256Hex } from '../domain/auth/secrets';
import { newUserId, type OrgId } from '../domain/ids';
import { createEngineCreationPolicy } from '../domain/registration/engine-creation-policy';
import { issueLinkCode, LINK_CODE_TTL_MS } from '../domain/registration/issue-link-code';
import type { LinkCodeStore } from '../domain/registration/link-code-store';
import { registerEngine, type RegisterEngineDeps } from '../domain/registration/register-engine';
import { createFakeEntitlements } from './fake-entitlements';
import { createMemoryAuthStore } from './memory-auth-store';
import { createMemoryRegistrationStores, type MemoryRegistrationStores } from './memory-registration-store';
import { createMemoryTeamStore } from './memory-team-store';
import type { MemberKeySource } from '../domain/teams/member-key';
import { TEST_ENGINE_DOMAIN } from './test-engine';

export const REGISTRATION_START_MS = 1_800_000_000_000;
export const TEST_RELAYS = [Hostname.parse('relay-1.ptbk.test'), Hostname.parse('relay-2.ptbk.test')];

/**
 * Link-code issuance and registration over the in-memory stores, fake entitlements (everything allowed until a test
 * grants less) and a fake clock. `wrapLinkCodes` lets a test interpose on the store registration sees, to stage races.
 */
export function createTestRegistration(
    options: {
        readonly wrapLinkCodes?: (store: LinkCodeStore, stores: MemoryRegistrationStores) => LinkCodeStore;
        readonly linkCodeTtlMs?: number;
        readonly engineDomain?: Hostname;
        readonly memberKey?: MemberKeySource;
    } = {},
) {
    const clock = createFakeClock(REGISTRATION_START_MS);
    const logger = createMemoryLogger();
    const stores = createMemoryRegistrationStores({ orgExists: () => true });
    const teams = createMemoryTeamStore({ auth: createMemoryAuthStore().state, registration: stores.state });
    const entitlements = createFakeEntitlements();
    const policy = createEngineCreationPolicy({
        entitlements,
        engines: stores.engines,
    });
    const signal = new AbortController().signal;
    const deps: RegisterEngineDeps = {
        linkCodes: options.wrapLinkCodes?.(stores.linkCodes, stores) ?? stores.linkCodes,
        engines: stores.engines,
        teams,
        random: cryptoRandom,
        memberKey: options.memberKey ?? (() => Promise.resolve(null)),
        policy,
        clock,
        logger,
        engineDomain: options.engineDomain ?? TEST_ENGINE_DOMAIN,
        relays: TEST_RELAYS,
    };
    const tryIssue = (orgId: OrgId) =>
        issueLinkCode(
            {
                linkCodes: stores.linkCodes,
                policy,
                random: cryptoRandom,
                clock,
                linkCodeTtlMs: options.linkCodeTtlMs ?? LINK_CODE_TTL_MS,
            },
            { orgId, userId: newUserId(cryptoRandom) },
            signal,
        );
    return {
        clock,
        logger,
        stores,
        teams,
        entitlements,
        tryIssue,
        async issue(orgId: OrgId): Promise<LinkCode> {
            const outcome = await tryIssue(orgId);
            if (outcome.kind !== 'issued') {
                throw new Error(`no link code: ${outcome.reason}`);
            }
            return outcome.linkCode;
        },
        /** Whether the code can still be redeemed now. */
        async unused(code: LinkCode): Promise<boolean> {
            return (await stores.linkCodes.findRedeemable(await sha256Hex(code), clock.nowMs())) !== null;
        },
        register: (request: RegisterEngineRequest) => registerEngine(deps, request, signal),
    };
}

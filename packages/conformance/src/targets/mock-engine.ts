import { PERMISSIONS } from '@ptbk/engine-api';

import type { ConformanceTarget, SessionCredential } from '../target';

export interface MockEngineTargetOptions {
    readonly baseUrl: URL;
    /** The mock engine's dev-only control listener (`MOCK_CONTROL=enabled`), e.g. `http://127.0.0.1:4480`. */
    readonly controlUrl: URL;
    readonly fetch: typeof fetch;
    readonly enginePublicKey?: string;
}

/** RFC 6265 token characters, so nothing the control listener sends can break out of the `Cookie` header. */
const COOKIE_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}$/;

/**
 * The mock engine, sessions from its control listener: `POST /__mock/sessions` signs in the seeded owner or a new
 * synthetic member holding exactly the permissions asked for. The real engine never has this endpoint; each engine
 * implements `session` its own way.
 */
export function createMockEngineTarget(options: MockEngineTargetOptions): ConformanceTarget {
    return {
        baseUrl: options.baseUrl,
        fetch: options.fetch,
        ...(options.enginePublicKey === undefined ? {} : { enginePublicKey: options.enginePublicKey }),
        gateway: true,
        // The mock's policy (M-04): without `members.manage`, a member changes only agents they created.
        memberPrivateResources: {
            permissions: PERMISSIONS.filter((permission) => permission !== 'members.manage'),
            agentRoutes: ['updateAgent', 'updateAgentSource', 'deleteAgent', 'restoreAgent'],
        },
        async walletRequest(origin) {
            const response = await options.fetch(new URL('/__mock/wallet-requests', options.controlUrl), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ origin }),
            });
            const data = (await response.json()) as { readonly request?: { readonly id?: unknown } };
            if (response.status !== 201 || typeof data.request?.id !== 'string') {
                throw new Error(
                    `the mock control listener answered ${String(response.status)} to POST /__mock/wallet-requests`,
                );
            }
            return data.request.id;
        },
        async session(subject): Promise<SessionCredential> {
            const body =
                subject.kind === 'owner'
                    ? { kind: 'owner' }
                    : { kind: 'member', permissions: [...subject.permissions] };
            const response = await options.fetch(new URL('/__mock/sessions', options.controlUrl), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ subject: body }),
            });
            if (response.status !== 201) {
                await response.body?.cancel();
                throw new Error(
                    `the mock control listener answered ${String(response.status)} to POST /__mock/sessions`,
                );
            }
            const data = (await response.json()) as {
                readonly cookie?: { readonly name?: unknown; readonly value?: unknown };
            };
            const name = data.cookie?.name;
            const value = data.cookie?.value;
            if (
                typeof name !== 'string' ||
                typeof value !== 'string' ||
                !COOKIE_TOKEN.test(name) ||
                !COOKIE_TOKEN.test(value)
            ) {
                throw new Error('the mock control listener sent no usable session cookie');
            }
            return { cookie: `${name}=${value}` };
        },
    };
}

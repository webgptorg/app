import { PERMISSIONS } from '@ptbk/engine-api';

import type { ConformanceTarget, LiveBrowserTarget, SessionCredential, SessionSubject } from '../target';

export interface MockEngineTargetOptions {
    readonly baseUrl: URL;
    /** The mock engine's dev-only control listener (`MOCK_CONTROL=enabled`), e.g. `http://127.0.0.1:4480`. */
    readonly controlUrl: URL;
    readonly fetch: typeof fetch;
    readonly enginePublicKey?: string;
    /**
     * How the platform opens the live channel (a WebSocket on the engine's origin, which `fetch` cannot do). With it, and
     * the mock started with `MOCK_LIVE_BROWSER=enabled`, the target drives `browser-tab@1`.
     */
    readonly openLiveChannel?: LiveBrowserTarget['openChannel'];
}

/** On the mock's sign-in allowlist (`MOCK_LIVE_BROWSER`). */
export const MOCK_SIGN_IN_ORIGIN = 'https://accounts.example';

/** RFC 6265 token characters, so nothing the control listener sends can break out of the `Cookie` header. */
const COOKIE_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}$/;

/**
 * The mock engine, sessions from its control listener: `POST /__mock/sessions` signs in the seeded owner or a new
 * synthetic member holding exactly the permissions asked for. The real engine never has this endpoint; each engine
 * implements `session` its own way.
 */
export function createMockEngineTarget(options: MockEngineTargetOptions): ConformanceTarget {
    const control = async (path: string, body: unknown, expected: number): Promise<unknown> => {
        const response = await options.fetch(new URL(path, options.controlUrl), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (response.status !== expected) {
            await response.body?.cancel();
            throw new Error(`the mock control listener answered ${String(response.status)} to POST ${path}`);
        }
        return expected === 204 ? null : ((await response.json()) as unknown);
    };
    const idOf = (data: unknown, field: 'tab' | 'request'): string => {
        const id = (data as Partial<Record<string, { readonly id?: unknown }>> | null)?.[field]?.id;
        if (typeof id !== 'string') throw new Error(`the mock control listener sent no ${field} ID`);
        return id;
    };
    const signIn = async (subject: SessionSubject, stepUp: 'fresh' | 'stale'): Promise<SessionCredential> => {
        const body =
            subject.kind === 'owner' ? { kind: 'owner' } : { kind: 'member', permissions: [...subject.permissions] };
        const request = { subject: body, ...(stepUp === 'stale' ? { stepUp } : {}) };
        const data = (await control('/__mock/sessions', request, 201)) as {
            readonly cookie?: { readonly name?: unknown; readonly value?: unknown };
        } | null;
        const name = data?.cookie?.name;
        const value = data?.cookie?.value;
        if (
            typeof name !== 'string' ||
            typeof value !== 'string' ||
            !COOKIE_TOKEN.test(name) ||
            !COOKIE_TOKEN.test(value)
        ) {
            throw new Error('the mock control listener sent no usable session cookie');
        }
        return { cookie: `${name}=${value}` };
    };
    const openChannel = options.openLiveChannel;
    const liveBrowser: LiveBrowserTarget | undefined =
        openChannel === undefined
            ? undefined
            : {
                  openChannel,
                  signInOrigin: MOCK_SIGN_IN_ORIGIN,
                  openAgentTab: async (origin) =>
                      idOf(await control('/__mock/live-browser/tabs', { origin }, 201), 'tab'),
                  requestHelp: async (tabId, reason, message) =>
                      idOf(
                          await control('/__mock/live-browser/help-requests', { tabId, reason, message }, 201),
                          'request',
                      ),
                  navigate: async (tabId, page) => {
                      await control('/__mock/live-browser/navigate', { tabId, page }, 204);
                  },
                  elapse: async (sessionId, what) => {
                      await control('/__mock/live-browser/elapse', { sessionId, what }, 204);
                  },
                  staleOwnerSession: () => signIn({ kind: 'owner' }, 'stale'),
              };
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
            const data = (await control('/__mock/wallet-requests', { origin }, 201)) as {
                readonly request?: { readonly id?: unknown };
            } | null;
            if (typeof data?.request?.id !== 'string') {
                throw new Error('the mock control listener answered 201 to POST /__mock/wallet-requests without an ID');
            }
            return data.request.id;
        },
        ...(liveBrowser === undefined ? {} : { liveBrowser }),
        session: (subject) => signIn(subject, 'fresh'),
    };
}

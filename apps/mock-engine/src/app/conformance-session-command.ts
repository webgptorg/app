import type { Permission } from '@ptbk/engine-api';
import { Permission as PermissionSchema } from '@ptbk/engine-api';

import type { MockEngineConfig } from './config';

export const CONFORMANCE_SESSION_USAGE =
    'usage: conformance-session --subject owner | --subject member --permissions <a,b,…>';

export class ConformanceSessionUsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConformanceSessionUsageError';
    }
}

export type ConformanceSessionSubject =
    { readonly kind: 'owner' } | { readonly kind: 'member'; readonly permissions: readonly Permission[] };

export function parseConformanceSessionCommand(args: readonly string[]): ConformanceSessionSubject {
    const [subjectFlag, subject, permissionsFlag, permissions, ...rest] = args;
    if (subjectFlag !== '--subject' || rest.length > 0)
        throw new ConformanceSessionUsageError(CONFORMANCE_SESSION_USAGE);
    if (subject === 'owner' && permissionsFlag === undefined) return { kind: 'owner' };
    if (subject !== 'member' || permissionsFlag !== '--permissions' || permissions === undefined) {
        throw new ConformanceSessionUsageError(CONFORMANCE_SESSION_USAGE);
    }
    const names = permissions === '' ? [] : permissions.split(',');
    const parsed = names.map((name) => PermissionSchema.safeParse(name));
    if (parsed.some((result) => !result.success)) throw new ConformanceSessionUsageError('unknown permission');
    return { kind: 'member', permissions: parsed.flatMap((result) => (result.success ? [result.data] : [])) };
}

/**
 * The conformance harness's session command (ENG-99) in the mock's terms: the sessions live in the running engine's
 * memory, so the command asks its dev-only control listener, which exists only with `MOCK_CONTROL=enabled` and never
 * in production. A real engine's conformance build would write the session where its gateway reads them instead.
 */
export async function runConformanceSessionCommand(
    subject: ConformanceSessionSubject,
    config: Pick<MockEngineConfig, 'control'>,
    fetch: typeof globalThis.fetch,
): Promise<{ readonly cookie: string }> {
    if (config.control === null)
        throw new ConformanceSessionUsageError('conformance-session needs MOCK_CONTROL=enabled');
    const host = config.control.host.includes(':') ? `[${config.control.host}]` : config.control.host;
    const response = await fetch(`http://${host}:${String(config.control.port)}/__mock/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject }),
    });
    if (response.status !== 201) {
        await response.body?.cancel();
        throw new Error(`the control listener answered ${String(response.status)}`);
    }
    const { cookie } = (await response.json()) as {
        readonly cookie: { readonly name: string; readonly value: string };
    };
    return { cookie: `${cookie.name}=${cookie.value}` };
}

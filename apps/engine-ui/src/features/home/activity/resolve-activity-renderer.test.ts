import type { Activity, ActivityItem } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import type { ActivityRendererEntry } from '../../../app/registry/feature';
import { resolveActivityRenderer } from './resolve-activity-renderer';

const entry = (kind: string, versions: readonly number[] = [1]): ActivityRendererEntry => ({
    kind,
    versions,
    component: () => null,
    summary: () => kind,
});

const base = {
    id: 'activity-1',
    at: '2026-10-01T12:00:00.000Z',
    agentId: 'agent-ada',
    agentName: 'Ada',
    actor: { kind: 'system' },
} as const;

const known = (kind: 'run.failed' | 'run.started'): ActivityItem => ({
    kind: 'known',
    activity: { ...base, kind, v: 1, runId: 'run-1', source: 'web', error: null } as unknown as Activity,
});

describe('resolveActivityRenderer', () => {
    const exact = entry('run.failed');
    const prefix = entry('run.*');

    it('prefers an exact kind, then the area prefix, then the generic card', () => {
        expect(resolveActivityRenderer(known('run.failed'), [prefix, exact])).toMatchObject({
            kind: 'renderer',
            entry: exact,
        });
        expect(resolveActivityRenderer(known('run.started'), [prefix, exact])).toMatchObject({
            kind: 'renderer',
            entry: prefix,
        });
        expect(resolveActivityRenderer(known('run.started'), [entry('file.*'), exact])).toEqual({ kind: 'fallback' });
    });

    it('skips an entry that does not claim the version', () => {
        expect(resolveActivityRenderer(known('run.failed'), [entry('run.failed', [2]), prefix])).toMatchObject({
            kind: 'renderer',
            entry: prefix,
        });
        expect(resolveActivityRenderer(known('run.failed'), [entry('run.*', [2])])).toEqual({ kind: 'fallback' });
    });

    it('gives an unknown kind, a higher version and an invalid item the generic card, whatever is registered', () => {
        const items: ActivityItem[] = [
            { kind: 'unknown', base: { ...base, kind: 'deploy.started', v: 1 } as never, raw: {} },
            { kind: 'unknown', base: { ...base, kind: 'run.failed', v: 2 } as never, raw: {} },
            { kind: 'invalid', base: { ...base, kind: 'run.failed', v: 1 } as never, issues: [] },
        ];
        for (const item of items) {
            expect(resolveActivityRenderer(item, [entry('run.failed', [1, 2]), entry('run.*', [1, 2])])).toEqual({
                kind: 'fallback',
            });
        }
    });
});

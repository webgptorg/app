import { describe, expect, it } from 'vitest';

import { activityKindMatches, findActivityRenderer } from './activity-renderers';
import { defineFeature } from './feature';
import type { ActivityRendererEntry } from './feature';

const entry = (kind: string, versions: readonly number[] = [1]): ActivityRendererEntry => ({
    kind,
    versions,
    component: () => null,
    summary: () => kind,
});

describe('activity renderers', () => {
    it('matches an exact kind or an area prefix, nothing else', () => {
        expect(activityKindMatches('run.*', 'run.failed')).toBe(true);
        expect(activityKindMatches('run.*', 'runs.failed')).toBe(false);
        expect(activityKindMatches('run.failed', 'run.failed')).toBe(true);
        expect(activityKindMatches('run.failed', 'run.started')).toBe(false);
    });

    it('prefers an exact kind, honours versions and finds nothing for an unclaimed kind', () => {
        const area = entry('integration.*');
        const exact = entry('integration.used');
        const features = [
            defineFeature({ id: 'a', requires: {}, activityRenderers: [area] }),
            defineFeature({ id: 'b', requires: {}, activityRenderers: [exact, entry('file.*', [2])] }),
        ];
        expect(findActivityRenderer(features, 'integration.used', 1)).toBe(exact);
        expect(findActivityRenderer(features, 'integration.error', 1)).toBe(area);
        expect(findActivityRenderer(features, 'integration.error', 2)).toBeUndefined();
        expect(findActivityRenderer(features, 'file.created', 1)).toBeUndefined();
        expect(findActivityRenderer(features, 'deploy.started', 1)).toBeUndefined();
    });
});

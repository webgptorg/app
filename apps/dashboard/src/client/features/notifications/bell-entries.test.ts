import { describe, expect, it } from 'vitest';

import type { NotificationView } from '../../../shared/api/notification-routes';
import { NOTIFICATION_KIND_IDS } from '../../../shared/notifications/registry';
import { ENGINE_DOMAIN, ENGINE_ID, NOW, notificationView } from '../../testing/fixtures';
import { bellEntries, bellRenderContext } from './bell-entries';

const SENTINEL = 'SENTINEL-engine-content';
const context = bellRenderContext('en', NOW);

/** A row as a misbehaving server might send it, with fields no contract has. */
function smuggling(row: NotificationView): NotificationView {
    return {
        ...row,
        title: SENTINEL,
        item: { name: SENTINEL },
        url: `https://evil.test/${SENTINEL}`,
    } as NotificationView;
}

describe('bell entries', () => {
    it('build every line and link only from dashboard-owned fields', () => {
        const rows = NOTIFICATION_KIND_IDS.map((kind, index) =>
            smuggling(
                notificationView({
                    id: `aaaaaaaaaaaaaaaaaaaaaaaa${String.fromCharCode(97 + index)}a`,
                    kind,
                    variant: null,
                }),
            ),
        );
        const entries = bellEntries(rows, 'Acme', context);
        expect(entries.length).toBeGreaterThan(0);
        for (const entry of entries) {
            expect(JSON.stringify(entry)).not.toContain(SENTINEL);
            expect(entry.line.length).toBeGreaterThan(0);
            if (entry.target.to === 'project') {
                expect(entry.target.href).toMatch(new RegExp(`^https://${ENGINE_ID}\\.${ENGINE_DOMAIN}/(members)?$`));
            }
        }
    });

    it('reads a variant of another kind as none', () => {
        const [entry] = bellEntries([notificationView({ kind: 'project-status', variant: 'joined' })], null, context);
        expect(entry?.line).toBe('Sales bot is online: finish setup on its terminal');
    });

    it('gives a project with one engine count its own line, and several one counted line', () => {
        const project = notificationView().project;
        const one = bellEntries([notificationView({ kind: 'agent-waiting', variant: null, project })], null, context);
        expect(one.map((entry) => entry.line)).toEqual(['An agent is waiting for you in Sales bot']);
        const several = bellEntries(
            [
                notificationView({
                    id: 'aaaaaaaaaaaaaaaaaaaaaaaaab',
                    kind: 'agent-waiting',
                    variant: null,
                    seen: true,
                }),
                notificationView({ id: 'aaaaaaaaaaaaaaaaaaaaaaaaac', kind: 'tool-sign-in', variant: null, count: 2 }),
            ],
            null,
            context,
        );
        expect(several).toEqual([
            {
                key: `project-${ENGINE_ID}`,
                line: '3 things need you in Sales bot',
                unseen: true,
                target: { to: 'project', href: `https://${ENGINE_ID}.${ENGINE_DOMAIN}/` },
            },
        ]);
    });

    it('names the day as well when a time is not today', () => {
        const yesterday = bellRenderContext('en', NOW + 24 * 3_600_000);
        expect(yesterday.time(NOW)).not.toBe(context.time(NOW));
        expect(yesterday.time(NOW)).toContain(context.time(NOW));
    });
});

import { describe, expect, it } from 'vitest';

import { createCan } from '../../features/session/permissions';
import { defineFeature } from './feature';
import { featureAccess, visibleFeatures } from './visibility';

const Icon = () => null;
const label = () => 'x';

const agents = defineFeature({
    id: 'agents',
    requires: { permission: 'agents.read' },
    nav: { group: 'work', order: 20, label, icon: Icon, to: '/agents' },
    agentTabs: [
        { id: 'overview', order: 0, label, to: '/agents' },
        { id: 'settings', order: 90, label, to: '/agents', requires: { permission: 'agents.write' } },
    ],
    commands: [
        { id: 'open', label, keywords: () => [], to: '/agents' },
        { id: 'delete', label, keywords: () => [], run: () => undefined, requires: { permission: 'agents.delete' } },
    ],
    agentOverviewCards: [{ id: 'audit', order: 1, component: Icon, requires: { permission: 'audit.read' } }],
});
const settings = defineFeature({ id: 'settings', requires: {} });

describe('visibleFeatures', () => {
    it('keeps a feature only with its permission, and filters its nested entries the same way', () => {
        const visible = visibleFeatures([agents, settings], { can: createCan(['agents.read']) });
        expect(visible.map((feature) => feature.id)).toEqual(['agents', 'settings']);
        const [visibleAgents] = visible;
        expect(visibleAgents?.agentTabs?.map((tab) => tab.id)).toEqual(['overview']);
        expect(visibleAgents?.commands?.map((command) => command.id)).toEqual(['open']);
        expect(visibleAgents?.agentOverviewCards).toEqual([]);
    });

    it('shows nothing gated to a member without permissions, and everything to one with all of them', () => {
        expect(visibleFeatures([agents, settings], { can: createCan([]) }).map((feature) => feature.id)).toEqual([
            'settings',
        ]);
        const all = visibleFeatures([agents, settings], {
            can: createCan(['agents.read', 'agents.write', 'agents.delete', 'audit.read']),
        });
        expect(all[0]?.agentTabs).toHaveLength(2);
        expect(all[0]?.commands).toHaveLength(2);
        expect(all[0]?.agentOverviewCards).toHaveLength(1);
    });

    it('ignores permission strings this UI does not know', () => {
        const can = createCan(['agents.read', 'agents.purge-everything', 'future.thing']);
        expect(can('agents.read')).toBe(true);
        expect(visibleFeatures([agents], { can })[0]?.commands?.map((command) => command.id)).toEqual(['open']);
    });

    it('explains why a feature route is closed', () => {
        expect(featureAccess(agents, { can: createCan([]) })).toBe('no-access');
        expect(featureAccess(agents, { can: createCan(['agents.read']) })).toBe('allowed');
        expect(featureAccess(settings, { can: createCan([]) })).toBe('allowed');
    });
});

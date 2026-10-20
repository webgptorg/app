import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { CapabilityRef } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import { accessFrom } from './engine-access';
import { defineFeature } from './feature';
import { featureAccess, visibleFeatures } from './visibility';
import type { Access } from './visibility';

const Icon = () => null;
const label = () => 'x';

const agents = defineFeature({
    id: 'agents',
    requires: { permission: 'agents.read' },
    nav: { group: 'work', order: 20, label, icon: Icon, to: '/agents' },
    agentTabs: [
        { id: 'overview', order: 0, label, to: '/agents' },
        { id: 'settings', order: 90, label, to: '/agents', requires: { permission: 'agents.write' } },
        { id: 'runs', order: 30, label, to: '/agents', requires: { capability: KNOWN_CAPABILITIES.runs } },
    ],
    commands: [
        { id: 'open', label, keywords: () => [], to: '/agents' },
        { id: 'delete', label, keywords: () => [], run: () => undefined, requires: { permission: 'agents.delete' } },
        {
            id: 'runs',
            label,
            keywords: () => [],
            to: '/agents',
            requires: { capability: KNOWN_CAPABILITIES.runs, permission: 'agents.read' },
        },
    ],
    agentOverviewCards: [{ id: 'audit', order: 1, component: Icon, requires: { permission: 'audit.read' } }],
});
const runs = defineFeature({
    id: 'runs',
    requires: { capability: KNOWN_CAPABILITIES.runs, permission: 'agents.read' },
    nav: { group: 'work', order: 40, label, icon: Icon, to: '/audit' },
});
const settings = defineFeature({ id: 'settings', requires: {} });

const access = (permissions: readonly string[], capabilities: readonly CapabilityRef[] = []): Access =>
    accessFrom({ capabilities: [...capabilities] }, permissions);

describe('visibleFeatures', () => {
    it('keeps a feature only with its permission, and filters its nested entries the same way', () => {
        const visible = visibleFeatures([agents, settings], access(['agents.read']));
        expect(visible.map((feature) => feature.id)).toEqual(['agents', 'settings']);
        const [visibleAgents] = visible;
        expect(visibleAgents?.agentTabs?.map((tab) => tab.id)).toEqual(['overview']);
        expect(visibleAgents?.commands?.map((command) => command.id)).toEqual(['open']);
        expect(visibleAgents?.agentOverviewCards).toEqual([]);
    });

    it('shows nothing gated to a member without permissions, and everything to one with all of them', () => {
        expect(visibleFeatures([agents, settings], access([])).map((feature) => feature.id)).toEqual(['settings']);
        const all = visibleFeatures(
            [agents, runs, settings],
            access(['agents.read', 'agents.write', 'agents.delete', 'audit.read'], [KNOWN_CAPABILITIES.runs]),
        );
        expect(all.map((feature) => feature.id)).toEqual(['agents', 'runs', 'settings']);
        expect(all[0]?.agentTabs).toHaveLength(3);
        expect(all[0]?.commands).toHaveLength(3);
        expect(all[0]?.agentOverviewCards).toHaveLength(1);
    });

    it('hides capability-gated features and nested entries when the engine does not advertise the capability', () => {
        const visible = visibleFeatures([agents, runs], access(['agents.read']));
        expect(visible.map((feature) => feature.id)).toEqual(['agents']);
        expect(visible[0]?.agentTabs?.map((tab) => tab.id)).toEqual(['overview']);
        expect(visible[0]?.commands?.map((command) => command.id)).toEqual(['open']);
    });

    it('ignores capabilities and versions it does not know', () => {
        const unknown = access(
            ['agents.read'],
            [
                { id: 'teleport', version: 1 },
                { id: 'runs', version: 2 },
            ],
        );
        expect(visibleFeatures([agents, runs], unknown).map((feature) => feature.id)).toEqual(['agents']);
    });

    it('ignores permission strings this UI does not know', () => {
        const visible = visibleFeatures([agents], access(['agents.read', 'agents.purge-everything', 'future.thing']));
        expect(visible[0]?.commands?.map((command) => command.id)).toEqual(['open']);
    });
});

describe('featureAccess', () => {
    it('says "unavailable" before "no access", so a missing capability is never blamed on the member', () => {
        expect(featureAccess(runs, access([]))).toBe('unavailable');
        expect(featureAccess(runs, access([], [KNOWN_CAPABILITIES.runs]))).toBe('no-access');
        expect(featureAccess(runs, access(['agents.read'], [KNOWN_CAPABILITIES.runs]))).toBe('allowed');
        expect(featureAccess(settings, access([]))).toBe('allowed');
    });
});

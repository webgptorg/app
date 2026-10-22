import { PERMISSIONS } from '@ptbk/engine-api';
import type { Permission } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import { homeVariant } from './home-variant';

describe('homeVariant', () => {
    it('gives the control center to a member with security.read', () => {
        expect(homeVariant(new Set<Permission>(['security.read']))).toBe('control-center');
        expect(homeVariant(new Set(PERMISSIONS))).toBe('control-center');
    });

    it.each([
        ['no permissions', []],
        ['everything but security.read', PERMISSIONS.filter((permission) => permission !== 'security.read')],
        ['a member’s usual set', ['agents.read', 'chats.read', 'chats.write', 'runs.read'] as Permission[]],
    ])('gives the member home to %s', (_label, permissions) => {
        expect(homeVariant(new Set(permissions))).toBe('member');
    });
});

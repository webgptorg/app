import type { Permission } from '@ptbk/engine-api';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { describe, expect, it } from 'vitest';

import { AccessDeniedError } from '../../app/access-denied';
import { EngineApiProvider } from '../../app/engine-api-context';
import { FEATURES } from '../../app/features';
import { createAppQueryClient } from '../../app/query-client';
import { createTestEngineApi } from '../../testing/test-engine-api';
import { requirePermission } from './require-permission';
import { useCurrentMember } from './use-current-member';
import { Can, usePermissions } from './use-permissions';

const engineApiFor = (permissions: readonly Permission[]) =>
    createTestEngineApi({ member: { permissions, role: 'viewer', displayName: 'Vera' } });

describe('requirePermission', () => {
    const context = (permissions: readonly Permission[]) => ({
        queryClient: createAppQueryClient({ onUnauthenticated: () => undefined }),
        engineApi: engineApiFor(permissions),
        features: FEATURES,
    });

    it('lets a member with the permission through', async () => {
        await expect(requirePermission('audit.read')({ context: context(['audit.read']) })).resolves.toBeUndefined();
    });

    it('shows "no access" to one without it', async () => {
        await expect(requirePermission('audit.read')({ context: context(['agents.read']) })).rejects.toEqual(
            new AccessDeniedError('no-access'),
        );
    });
});

describe('the current member', () => {
    it('exposes identity, a role label for display and permissions, and renders by permission', async () => {
        function Probe() {
            const member = useCurrentMember();
            const { can } = usePermissions();
            return (
                <>
                    <p>{`${member.displayName} ${member.roleLabel} ${String(can('agents.read'))} ${String(can('audit.read'))}`}</p>
                    <Can permission="agents.read">
                        <span>{'may read agents'}</span>
                    </Can>
                    <Can permission="audit.read" fallback={<span>{'no audit'}</span>}>
                        <span>{'may read audit'}</span>
                    </Can>
                    <Can permission="wallet.manage">
                        <span>{'may manage secrets'}</span>
                    </Can>
                </>
            );
        }
        render(
            <EngineApiProvider client={engineApiFor(['agents.read'])}>
                <QueryClientProvider client={createAppQueryClient({ onUnauthenticated: () => undefined })}>
                    <Suspense fallback={null}>
                        <Probe />
                    </Suspense>
                </QueryClientProvider>
            </EngineApiProvider>,
        );

        expect(await screen.findByText('Vera viewer true false')).toBeDefined();
        expect(screen.getByText('may read agents')).toBeDefined();
        expect(screen.getByText('no audit')).toBeDefined();
        expect(screen.queryByText('may manage secrets')).toBeNull();
    });
});

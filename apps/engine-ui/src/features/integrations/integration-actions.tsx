import type { ReadIntegration } from '@ptbk/engine-api';
import { ActionMenu, Button, ConfirmDialog } from '@ptbk/ui';
import { useNavigate } from '@tanstack/react-router';
import { Pencil, Plug, PlugZap, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { m } from '../../paraglide/messages';
import { usePermissions } from '../session/use-permissions';
import { LazyIntegrationFormDialog } from './lazy-integration-form-dialog';
import { useIntegrationMutations } from './use-integration-mutations';

/**
 * The header actions for members with `integrations.manage`: the one or two used most as soft buttons (enable a
 * disabled integration, or check a running one, and edit), the rest in "More actions" with delete last and set apart.
 * Enable and disable are optimistic; a check waits for the engine and shows the status it returns.
 */
export function IntegrationActions({ integration }: { readonly integration: ReadIntegration }) {
    const { can } = usePermissions();
    const mutations = useIntegrationMutations();
    const navigate = useNavigate();
    const [editing, setEditing] = useState(false);
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    if (!can('integrations.manage')) return null;
    const target = { id: integration.id, name: integration.name };
    const disabled = integration.status === 'disconnected';
    const check = () => {
        mutations.check.mutate(target);
    };
    return (
        <div className="flex flex-wrap gap-2">
            {disabled ? (
                <Button
                    variant="primary"
                    loading={mutations.enable.isPending}
                    onClick={() => {
                        mutations.enable.mutate(target);
                    }}
                >
                    <PlugZap aria-hidden className="size-4" />
                    {m.integration_enable()}
                </Button>
            ) : (
                <Button loading={mutations.check.isPending} onClick={check}>
                    <RefreshCw aria-hidden className="size-4" />
                    {m.integration_check()}
                </Button>
            )}
            <Button
                onClick={() => {
                    setEditing(true);
                }}
            >
                <Pencil aria-hidden className="size-4" />
                {m.integration_edit()}
            </Button>
            <ActionMenu
                items={[
                    disabled
                        ? {
                              kind: 'item',
                              id: 'check',
                              label: m.integration_check(),
                              icon: <RefreshCw aria-hidden />,
                              disabled: mutations.check.isPending,
                              onSelect: check,
                          }
                        : {
                              kind: 'item',
                              id: 'disable',
                              label: m.integration_disable(),
                              icon: <Plug aria-hidden />,
                              disabled: mutations.disable.isPending,
                              onSelect: () => {
                                  mutations.disable.mutate(target);
                              },
                          },
                    { kind: 'separator', id: 'danger' },
                    {
                        kind: 'item',
                        id: 'delete',
                        label: m.integration_delete(),
                        icon: <Trash2 aria-hidden />,
                        tone: 'danger',
                        onSelect: () => {
                            setConfirmingDelete(true);
                        },
                    },
                ]}
            />
            {editing ? (
                <LazyIntegrationFormDialog
                    mode={{ kind: 'edit', integration }}
                    mutations={mutations}
                    onClose={() => {
                        setEditing(false);
                    }}
                />
            ) : null}
            <ConfirmDialog
                open={confirmingDelete}
                onClose={() => {
                    setConfirmingDelete(false);
                }}
                onConfirm={async () => {
                    try {
                        await mutations.remove.mutateAsync(target);
                        setConfirmingDelete(false);
                        void navigate({ to: '/integrations' });
                    } catch {
                        // Reported in a toast; the dialog stays open for another try.
                    }
                }}
                title={m.integration_delete_title({ name: integration.name })}
                description={m.integration_delete_body()}
                confirmLabel={m.integration_delete()}
                tone="danger"
                loading={mutations.remove.isPending}
            />
        </div>
    );
}

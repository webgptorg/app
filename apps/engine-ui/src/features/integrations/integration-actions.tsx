import type { ReadIntegration } from '@ptbk/engine-api';
import { Button, ConfirmDialog } from '@ptbk/ui';
import { useNavigate } from '@tanstack/react-router';
import { Pencil, Plug, PlugZap, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { m } from '../../paraglide/messages';
import { usePermissions } from '../session/use-permissions';
import { LazyIntegrationFormDialog } from './lazy-integration-form-dialog';
import { useIntegrationMutations } from './use-integration-mutations';

/**
 * Enable or disable (optimistic), check the connection (waits for the engine and shows the status it returns), edit
 * and delete (after confirmation). Nothing renders without `integrations.manage`.
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
                <Button
                    loading={mutations.disable.isPending}
                    onClick={() => {
                        mutations.disable.mutate(target);
                    }}
                >
                    <Plug aria-hidden className="size-4" />
                    {m.integration_disable()}
                </Button>
            )}
            <Button
                loading={mutations.check.isPending}
                onClick={() => {
                    mutations.check.mutate(target);
                }}
            >
                <RefreshCw aria-hidden className="size-4" />
                {m.integration_check()}
            </Button>
            <Button
                onClick={() => {
                    setEditing(true);
                }}
            >
                <Pencil aria-hidden className="size-4" />
                {m.integration_edit()}
            </Button>
            <Button
                variant="danger"
                onClick={() => {
                    setConfirmingDelete(true);
                }}
            >
                <Trash2 aria-hidden className="size-4" />
                {m.integration_delete()}
            </Button>
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

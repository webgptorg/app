import {
    Badge,
    Banner,
    Card,
    CodeText,
    ErrorState,
    Form,
    FormField,
    FormSubmit,
    Skeleton,
    Textarea,
    useLocale,
    useZodForm,
} from '@ptbk/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, type ReactNode } from 'react';
import { z } from 'zod';

import { m } from '../../../../paraglide/messages';
import { apiRoutes, SUSPENSION_REASON_MAX, type AdminEngineView } from '../../../../shared/api/routes';
import { useApiClient } from '../../../api/api-client-context';
import { adminEngineQuery, dataOrThrow, problemCode, queryKeys } from '../../../api/queries';
import { useAppMutation } from '../../../core/mutations';
import { Link } from '../../../core/link';

function StatusBadge(props: { readonly engine: AdminEngineView }) {
    switch (props.engine.suspendedBy) {
        case null:
            return <Badge tone="success">{m.admin_engine_status_active()}</Badge>;
        case 'platform':
            return <Badge tone="danger">{m.admin_engine_status_platform()}</Badge>;
        case 'owner':
            return <Badge tone="neutral">{m.admin_engine_status_owner()}</Badge>;
    }
}

function errorMessage(error: unknown): string | undefined {
    return problemCode(error) === 'owner-revoked' ? m.admin_engine_revoked_body() : undefined;
}

/**
 * One form for both directions: suspending an active engine and lifting a platform suspension each need a reason,
 * a fresh step-up (asked for in place by `useAppMutation`), and land in the audit log.
 */
function SuspensionCard(props: { readonly engine: AdminEngineView; readonly direction: 'suspend' | 'unsuspend' }) {
    const api = useApiClient();
    const queryClient = useQueryClient();
    const { engineId } = props.engine;
    const suspending = props.direction === 'suspend';
    const change = useAppMutation({
        mutationFn: async (reason: string) =>
            dataOrThrow(
                await api.call(suspending ? apiRoutes.adminSuspendEngine : apiRoutes.adminUnsuspendEngine, {
                    params: { engineId },
                    body: { reason },
                }),
            ).engine,
        invalidates: [queryKeys.adminEngine(engineId)],
        successMessage: () => (suspending ? m.admin_engine_suspended() : m.admin_engine_unsuspended()),
        errorMessage,
        onSuccess: (engine) => {
            queryClient.setQueryData(queryKeys.adminEngine(engineId), engine);
        },
    });
    const schema = useMemo(
        () =>
            z.strictObject({
                reason: z
                    .string()
                    .trim()
                    .min(1, { error: m.admin_engine_reason_required() })
                    .max(SUSPENSION_REASON_MAX, { error: m.admin_engine_reason_too_long() }),
            }),
        [],
    );
    const form = useZodForm({
        schema,
        defaultValues: { reason: '' },
        onSubmit: async ({ reason }, current) => {
            try {
                await change.mutateAsync(reason);
                current.reset();
            } catch {
                // Reported in a toast by the mutation; the reason stays so the admin can retry.
            }
        },
    });
    return (
        <Card title={suspending ? m.admin_engine_suspend_title() : m.admin_engine_unsuspend_title()}>
            <Form form={form} className="flex flex-col gap-4">
                <p className="text-sm">
                    {suspending ? m.admin_engine_suspend_body() : m.admin_engine_unsuspend_body()}
                </p>
                <FormField
                    form={form}
                    name="reason"
                    label={m.admin_engine_reason_label()}
                    hint={m.admin_engine_reason_hint()}
                    required
                >
                    {({ text }) => <Textarea {...text} rows={3} />}
                </FormField>
                <div>
                    <FormSubmit form={form} variant={suspending ? 'danger' : 'primary'}>
                        {suspending ? m.admin_engine_suspend_submit() : m.admin_engine_unsuspend_submit()}
                    </FormSubmit>
                </div>
            </Form>
        </Card>
    );
}

function EngineFacts(props: { readonly engine: AdminEngineView }) {
    const formatters = useLocale();
    const { engine } = props;
    const facts: readonly (readonly [string, ReactNode])[] = [
        [m.admin_engine_id_label(), <CodeText value={engine.engineId} />],
        [m.admin_engine_org_label(), <CodeText value={engine.orgId} />],
        [m.admin_engine_hostname_label(), <CodeText value={engine.hostname} />],
        [m.admin_engine_status_label(), <StatusBadge engine={engine} />],
        [m.admin_engine_created_label(), formatters.formatDateTime(new Date(engine.createdAt))],
        [m.admin_engine_updated_label(), formatters.formatDateTime(new Date(engine.updatedAt))],
    ];
    return (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[minmax(10rem,max-content)_1fr]">
            {facts.map(([label, value]) => (
                <div key={label} className="contents">
                    <dt className="text-sm text-text-muted">{label}</dt>
                    <dd className="min-w-0 text-sm">{value}</dd>
                </div>
            ))}
        </dl>
    );
}

/** `/admin/engines/$engineId` (I-05): any organization's engine, with suspension and the way to its custom domains. */
export function AdminEnginePage(props: { readonly engineId: string }) {
    const api = useApiClient();
    const engine = useQuery(adminEngineQuery(api, props.engineId));
    const heading = <h1 className="font-display text-2xl font-semibold">{m.admin_engine_title()}</h1>;

    if (problemCode(engine.error) === 'not-found') {
        return (
            <div className="flex flex-col gap-6">
                {heading}
                <Banner tone="warning">{m.admin_engine_not_found()}</Banner>
            </div>
        );
    }
    if (engine.isError) {
        return (
            <div className="flex flex-col gap-6">
                {heading}
                <ErrorState
                    message={m.admin_engine_load_failed()}
                    retrying={engine.isFetching}
                    onRetry={() => {
                        void engine.refetch();
                    }}
                />
            </div>
        );
    }
    if (engine.data === undefined) {
        return (
            <div className="flex flex-col gap-6">
                {heading}
                <Skeleton className="h-40" />
            </div>
        );
    }
    const view = engine.data;
    return (
        <div className="flex flex-col gap-6">
            {heading}
            <Card>
                <EngineFacts engine={view} />
            </Card>
            <Link to="/admin/engines/$engineId/hostnames" params={{ engineId: view.engineId }} className="self-start">
                {m.admin_engine_hostnames_link()}
            </Link>
            {view.suspendedBy === 'owner' ? (
                <Banner tone="info">{m.admin_engine_revoked_body()}</Banner>
            ) : (
                <SuspensionCard
                    key={view.status}
                    engine={view}
                    direction={view.status === 'active' ? 'suspend' : 'unsuspend'}
                />
            )}
        </div>
    );
}

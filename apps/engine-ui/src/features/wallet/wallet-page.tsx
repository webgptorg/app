import type { ReadWalletOverview, ReadWalletRecord, ReadWalletRequest } from '@ptbk/engine-api';
import {
    ActionMenu,
    Badge,
    Button,
    Card,
    ConfirmDialog,
    EmptyState,
    ErrorState,
    RelativeTime,
    Skeleton,
} from '@ptbk/ui';
import type { BadgeTone } from '@ptbk/ui';
import { getRouteApi } from '@tanstack/react-router';
import { KeyRound, Plus } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';

import { m } from '../../paraglide/messages';
import { usePermissions } from '../session/use-permissions';
import { Page } from '../shell/page';
import type { LoginDialogTarget } from './login-dialog';
import { useResumedStepUp } from '../step-up/step-up';
import { REMOVE_LOGIN_ACTION, SAVE_LOGIN_ACTION, useWalletMutations } from './use-wallet-mutations';
import type { WalletMutations } from './use-wallet-mutations';
import { siteName } from './wallet-origin';
import { useWallet } from './wallet-queries';

const route = getRouteApi('/wallet');

// The dialog brings the form layer, so it loads when first opened rather than with the page.
const LoginDialog = lazy(() => import('./login-dialog').then((module) => ({ default: module.LoginDialog })));

function verificationLook(record: ReadWalletRecord): { readonly label: string; readonly tone: BadgeTone } {
    switch (record.verification?.state) {
        case 'verified':
            return { label: m.wallet_status_verified(), tone: 'success' };
        case 'rejected':
            return { label: m.wallet_status_rejected(), tone: 'danger' };
        case 'incomplete':
            return { label: m.wallet_status_incomplete(), tone: 'warning' };
        case 'unknown':
        case undefined:
            return { label: m.wallet_status_unverified(), tone: 'neutral' };
    }
}

/** The one line a Wallet that is not ready gets: it is set up and unlocked on the server, never from here. */
function notReadyLine(wallet: ReadWalletOverview): string {
    switch (wallet.state) {
        case 'locked':
            return m.wallet_state_locked({ count: String(wallet.lockedRecords) });
        case 'unavailable':
            return m.wallet_state_unavailable();
        case 'empty':
        case 'setup':
        case 'ready':
        case 'unknown':
            return m.wallet_state_not_set_up();
    }
}

function LoginRow({
    record,
    canManage,
    onUpdate,
    onRemove,
}: {
    readonly record: ReadWalletRecord;
    readonly canManage: boolean;
    readonly onUpdate: () => void;
    readonly onRemove: () => void;
}) {
    const look = verificationLook(record);
    return (
        <li className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0 sm:items-center">
            <div className="flex min-w-0 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2 font-medium break-words">
                    {record.label}
                    <Badge tone={look.tone}>{look.label}</Badge>
                </span>
                <span className="text-sm break-words text-text-muted">
                    {siteName(record.origin)}
                    {record.username === null ? null : ` · ${record.username}`}
                    {record.fields.length === 0
                        ? null
                        : ` · ${m.wallet_fields({ labels: record.fields.map(({ label }) => label).join(', ') })}`}
                </span>
                {record.verification !== null && record.verification.state !== 'verified' ? (
                    <span className="text-sm text-text-muted">{record.verification.reason}</span>
                ) : null}
                <span className="text-sm text-text-muted">
                    {record.lastUse === null ? (
                        m.wallet_never_used()
                    ) : (
                        <>
                            {m.wallet_last_used()} <RelativeTime value={new Date(record.lastUse.at)} />
                        </>
                    )}
                </span>
            </div>
            {canManage ? (
                <span className="flex shrink-0 items-center gap-1">
                    <Button size="sm" variant="secondary" onClick={onUpdate}>
                        {m.wallet_update()}
                    </Button>
                    <ActionMenu
                        label={m.wallet_login_actions({ label: record.label })}
                        variant="ghost"
                        size="sm"
                        items={[
                            {
                                kind: 'item',
                                id: 'remove',
                                label: m.wallet_remove(),
                                tone: 'danger',
                                onSelect: onRemove,
                            },
                        ]}
                    />
                </span>
            ) : null}
        </li>
    );
}

/** "Sales Follow-up needs a login for app.hubspot.com", in the words of the request's problem. */
function requestHeadline(request: ReadWalletRequest): string {
    const agent = request.agents[0] ?? m.wallet_request_system_agent();
    const site = siteName(request.origin);
    switch (request.problem) {
        case 'rejected':
            return m.wallet_request_rejected({ agent, site });
        case 'field':
            return m.wallet_request_field({ agent, site });
        case 'code':
            return m.wallet_request_code({ agent, site });
        case 'locked':
            return m.wallet_request_locked({ agent, site });
        case 'missing':
        case 'unknown':
            return m.wallet_request_missing({ agent, site });
    }
}

/** Only these can be answered here; a one-time code and an unlock happen on the server. */
function answerable(request: ReadWalletRequest): boolean {
    return request.problem === 'missing' || request.problem === 'rejected' || request.problem === 'field';
}

function RequestRow({
    request,
    record,
    canManage,
    ready,
    mutations,
    onAnswer,
}: {
    readonly request: ReadWalletRequest;
    readonly record: ReadWalletRecord | undefined;
    readonly canManage: boolean;
    readonly ready: boolean;
    readonly mutations: WalletMutations;
    readonly onAnswer: () => void;
}) {
    const target = { id: request.id, step: request.step, origin: request.origin };
    const canAnswer = canManage && ready && answerable(request);
    return (
        <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2 font-medium break-words">
                    {requestHeadline(request)}
                    {request.seenAt === null ? null : <Badge>{m.wallet_request_seen()}</Badge>}
                </span>
                {request.tasks.length === 0 ? null : (
                    <span className="text-sm break-words">
                        {m.wallet_request_for({ tasks: request.tasks.join(', ') })}
                    </span>
                )}
                <span className="text-sm break-words text-text-muted">
                    {request.account === null ? null : `${m.wallet_request_account({ account: request.account })} · `}
                    {m.wallet_request_asked()} <RelativeTime value={new Date(request.createdAt)} />
                </span>
                {answerable(request) ? null : (
                    <span className="text-sm text-text-muted">{m.wallet_request_on_server()}</span>
                )}
            </div>
            {canManage ? (
                <span className="flex shrink-0 flex-wrap items-center gap-1">
                    {canAnswer ? (
                        <Button size="sm" variant="primary" onClick={onAnswer}>
                            {record === undefined ? m.wallet_add_login() : m.wallet_update()}
                        </Button>
                    ) : null}
                    {request.seenAt === null ? (
                        <Button
                            size="sm"
                            variant="secondary"
                            loading={mutations.markSeen.isPending && mutations.markSeen.variables.id === request.id}
                            onClick={() => {
                                mutations.markSeen.mutate(target);
                            }}
                        >
                            {m.wallet_mark_seen()}
                        </Button>
                    ) : null}
                    <ActionMenu
                        label={m.wallet_request_actions({ site: siteName(request.origin) })}
                        variant="ghost"
                        size="sm"
                        items={[
                            {
                                kind: 'item',
                                id: 'reject',
                                label: m.wallet_reject(),
                                description: m.wallet_reject_hint(),
                                tone: 'danger',
                                onSelect: () => {
                                    mutations.reject.mutate(target);
                                },
                            },
                        ]}
                    />
                </span>
            ) : null}
        </li>
    );
}

const NO_RECORDS: readonly ReadWalletRecord[] = [];

interface ResumedSave {
    readonly recordId: string | undefined;
    readonly requestId: string | undefined;
    readonly values: { readonly origin: string; readonly username: string; readonly label?: string };
}

const optionalId = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length <= 64 ? value : undefined;

/** The form as the member left it for the passkey check; anything else in storage is ignored. */
function parseResumedSave(data: unknown): ResumedSave | undefined {
    if (typeof data !== 'object' || data === null) return undefined;
    const { recordId, requestId, origin, username, label } = data as Record<string, unknown>;
    if (typeof origin !== 'string' || typeof username !== 'string' || origin.length > 2048 || username.length > 320) {
        return undefined;
    }
    return {
        recordId: optionalId(recordId),
        requestId: optionalId(requestId),
        values: { origin, username, ...(typeof label === 'string' && label.length <= 200 ? { label } : {}) },
    };
}

function parseResumedRemove(data: unknown): string | undefined {
    return typeof data === 'object' && data !== null
        ? optionalId((data as Record<string, unknown>)['recordId'])
        : undefined;
}

const withRecord = (record: ReadWalletRecord | undefined) => (record === undefined ? {} : { record });
const withRequest = (request: ReadWalletRequest | undefined) => (request === undefined ? {} : { request });

type Pending =
    | { readonly kind: 'login'; readonly target: LoginDialogTarget }
    | { readonly kind: 'remove'; readonly record: ReadWalletRecord };

/**
 * The engine's Wallet: saved logins without their secrets, then what agents are waiting for. Passwords go in through
 * the login form only and never come back; setup, unlocking and the words for recovery stay on the server.
 */
export function WalletPage() {
    const search = route.useSearch();
    const navigate = route.useNavigate();
    const { can } = usePermissions();
    const canManage = can('wallet.manage');
    const wallet = useWallet();
    const mutations = useWalletMutations();
    const [pending, setPending] = useState<Pending | null>(null);
    const ready = wallet.data?.state === 'ready';
    const close = () => {
        setPending(null);
        setResumeDone(true);
        if (search.dialog !== undefined) {
            void navigate({ search: (previous) => ({ ...previous, dialog: undefined }), replace: true });
        }
    };
    const resumedSave = useResumedStepUp(SAVE_LOGIN_ACTION, parseResumedSave);
    const resumedRemove = useResumedStepUp(REMOVE_LOGIN_ACTION, parseResumedRemove);
    const [resumeDone, setResumeDone] = useState(false);
    const records = wallet.data?.records ?? NO_RECORDS;
    const resumedTarget: LoginDialogTarget | null =
        resumedSave === undefined || resumeDone || !canManage || !ready
            ? null
            : {
                  ...withRecord(records.find(({ id }) => id === resumedSave.recordId)),
                  ...withRequest(wallet.data?.pending.find(({ id }) => id === resumedSave.requestId)),
                  resumed: resumedSave.values,
              };
    const resumedRecord =
        resumedRemove === undefined || resumeDone || !canManage
            ? undefined
            : records.find(({ id }) => id === resumedRemove);
    const loginTarget: LoginDialogTarget | null =
        pending?.kind === 'login'
            ? pending.target
            : (resumedTarget ?? (search.dialog === 'new' && canManage && ready ? {} : null));
    const removing = pending?.kind === 'remove' ? pending.record : resumedRecord;

    const addLogin =
        canManage && ready ? (
            <Button
                variant="primary"
                onClick={() => {
                    setPending({ kind: 'login', target: {} });
                }}
            >
                <Plus aria-hidden className="size-4" />
                {m.wallet_add_login()}
            </Button>
        ) : null;

    return (
        <Page title={m.wallet_title()} description={m.wallet_description()} actions={addLogin}>
            {wallet.isPending ? (
                <Skeleton shape="block" className="h-40 w-full" />
            ) : wallet.isError ? (
                <ErrorState
                    message={m.wallet_load_failed()}
                    onRetry={() => {
                        void wallet.refetch();
                    }}
                />
            ) : (
                <>
                    {ready ? null : <p className="text-sm">{notReadyLine(wallet.data)}</p>}
                    {ready ? (
                        wallet.data.records.length === 0 ? (
                            <EmptyState
                                icon={<KeyRound />}
                                headingLevel={2}
                                title={m.wallet_empty_title()}
                                description={m.wallet_empty_body()}
                            />
                        ) : (
                            <Card title={m.wallet_logins_title()} titleLevel={2}>
                                <ul className="flex flex-col divide-y divide-divider">
                                    {wallet.data.records.map((record) => (
                                        <LoginRow
                                            key={record.id}
                                            record={record}
                                            canManage={canManage}
                                            onUpdate={() => {
                                                setPending({ kind: 'login', target: { record } });
                                            }}
                                            onRemove={() => {
                                                setPending({ kind: 'remove', record });
                                            }}
                                        />
                                    ))}
                                </ul>
                            </Card>
                        )
                    ) : null}
                    {wallet.data.pending.length === 0 ? null : (
                        <Card title={m.wallet_requests_title()} titleLevel={2}>
                            <ul className="flex flex-col divide-y divide-divider">
                                {wallet.data.pending.map((request) => {
                                    const record = wallet.data.records.find(({ id }) => id === request.recordId);
                                    return (
                                        <RequestRow
                                            key={request.id}
                                            request={request}
                                            record={record}
                                            canManage={canManage}
                                            ready={ready}
                                            mutations={mutations}
                                            onAnswer={() => {
                                                setPending({
                                                    kind: 'login',
                                                    target: record === undefined ? { request } : { record, request },
                                                });
                                            }}
                                        />
                                    );
                                })}
                            </ul>
                        </Card>
                    )}
                    <details className="text-sm text-text-muted">
                        <summary className="cursor-pointer">{m.wallet_trust_summary()}</summary>
                        <p className="mt-2 max-w-prose">{m.wallet_trust_body()}</p>
                    </details>
                </>
            )}
            {loginTarget === null ? null : (
                <Suspense fallback={null}>
                    <LoginDialog target={loginTarget} onClose={close} mutations={mutations} />
                </Suspense>
            )}
            {removing === undefined ? null : (
                <ConfirmDialog
                    open
                    onClose={close}
                    title={m.wallet_remove_title({ label: removing.label })}
                    description={m.wallet_remove_body()}
                    confirmLabel={m.wallet_remove()}
                    tone="danger"
                    loading={mutations.remove.isPending}
                    onConfirm={() => {
                        mutations.remove.mutate({ id: removing.id, label: removing.label }, { onSuccess: close });
                    }}
                />
            )}
        </Page>
    );
}

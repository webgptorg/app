import type { ReadWalletOverview, ReadWalletRecord, ReadWalletRequest } from '@ptbk/engine-api';
import {
    ActionMenu,
    Button,
    ConfirmDialog,
    EmptyState,
    ErrorState,
    RelativeTime,
    Section,
    Skeleton,
    STATUS_TINT_CLASSES,
    StatusPill,
} from '@ptbk/ui';
import type { MenuEntry, StatusTone } from '@ptbk/ui';
import { getRouteApi } from '@tanstack/react-router';
import { Ban, Eye, Globe, KeyRound, Plus } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';

import { cx } from '../../app/cx';
import { m } from '../../paraglide/messages';
import { AgentAvatar } from '../agents/agent-avatar';
import { usePermissions } from '../session/use-permissions';
import { Page } from '../shell/page';
import type { LoginDialogTarget } from './login-dialog';
import { useResumedStepUp } from '../step-up/step-up';
import { SAVE_LOGIN_ACTION, useWalletMutations } from './use-wallet-mutations';
import type { WalletMutations } from './use-wallet-mutations';
import { loginTitle } from './login-title';
import { useAgentLookByName } from './use-agent-look-by-name';
import { WalletTrust } from './wallet-trust';
import { siteName } from './wallet-origin';
import { useWallet } from './wallet-queries';

const route = getRouteApi('/wallet');

// The dialog brings the form layer, so it loads when first opened rather than with the page.
const LoginDialog = lazy(() => import('./login-dialog').then((module) => ({ default: module.LoginDialog })));

function verificationLook(record: ReadWalletRecord): { readonly label: string; readonly tone: StatusTone } {
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
    const { title, site } = loginTitle(record.label, siteName(record.origin));
    // The site shows once: as the title, or beside a name the owner gave the login.
    const details = [
        ...(site === null ? [] : [site]),
        ...(record.username === null ? [] : [record.username]),
        ...(record.fields.length === 0
            ? []
            : [m.wallet_fields({ labels: record.fields.map(({ label }) => label).join(', ') })]),
    ].join(' · ');
    return (
        <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
            <span
                aria-hidden
                className="flex size-8 shrink-0 items-center justify-center rounded-control bg-hover text-text-muted"
            >
                <Globe className="size-4" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    {/* Labels and usernames come from the engine: text nodes only. */}
                    <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{title}</span>
                    <StatusPill
                        tone={look.tone}
                        variant={look.tone === 'danger' || look.tone === 'warning' ? 'soft' : 'quiet'}
                    >
                        {look.label}
                    </StatusPill>
                </span>
                {details === '' ? null : (
                    <span className="text-xs [overflow-wrap:anywhere] text-text-muted">{details}</span>
                )}
                {record.verification !== null && record.verification.state !== 'verified' ? (
                    <span className="text-xs text-text-muted">{record.verification.reason}</span>
                ) : null}
            </div>
            {/* On phones the time wraps under the name, aligned with it, instead of squeezing the row. */}
            <span className="order-last basis-full ps-11 text-xs whitespace-nowrap text-text-muted tabular-nums sm:order-none sm:basis-auto sm:ps-0">
                {record.lastUse === null ? (
                    m.wallet_never_used()
                ) : (
                    <>
                        {m.wallet_last_used()} <RelativeTime value={new Date(record.lastUse.at)} />
                    </>
                )}
            </span>
            {canManage ? (
                <span className="flex shrink-0 items-center gap-1">
                    <Button size="sm" onClick={onUpdate}>
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
                                icon: <Ban />,
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

function RequestAvatar({ name }: { readonly name: string }) {
    const look = useAgentLookByName(name);
    return <AgentAvatar name={name} agentKey={look.key} profile={look.profile} origin={look.origin} size="xs" />;
}

/**
 * One login an agent waits for, on a soft surface like Home's "Needs you": who asks and for what, one action that
 * answers it, and the quieter answers (seen, reject) in the ⋯ menu. A seen request still waits, but calmly.
 */
function RequestItem({
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
    const seen = request.seenAt !== null;
    const agent = request.agents[0] ?? m.wallet_request_system_agent();
    const items: MenuEntry[] = [
        ...(seen
            ? []
            : [
                  {
                      kind: 'item' as const,
                      id: 'seen',
                      label: m.wallet_mark_seen(),
                      icon: <Eye />,
                      disabled: mutations.markSeen.isPending && mutations.markSeen.variables.id === request.id,
                      onSelect: () => {
                          mutations.markSeen.mutate(target);
                      },
                  },
                  { kind: 'separator' as const, id: 'danger' },
              ]),
        {
            kind: 'item',
            id: 'reject',
            label: m.wallet_reject(),
            description: m.wallet_reject_hint(),
            icon: <Ban />,
            tone: 'danger',
            onSelect: () => {
                mutations.reject.mutate(target);
            },
        },
    ];
    return (
        <li
            className={cx(
                'soft-surface flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3',
                STATUS_TINT_CLASSES[seen ? 'neutral' : 'warning'],
            )}
        >
            <span className="mt-0.5 flex shrink-0">
                <RequestAvatar name={agent} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {/* Agent, task and site names come from the engine: text nodes only. */}
                    <span className="text-sm font-medium [overflow-wrap:anywhere]">{requestHeadline(request)}</span>
                    {seen ? (
                        <StatusPill tone="neutral" variant="quiet">
                            {m.wallet_request_seen()}
                        </StatusPill>
                    ) : null}
                </span>
                {request.tasks.length === 0 ? null : (
                    <span className="text-sm [overflow-wrap:anywhere] text-text-muted">
                        {m.wallet_request_for({ tasks: request.tasks.join(', ') })}
                    </span>
                )}
                <span className="text-xs [overflow-wrap:anywhere] text-text-muted tabular-nums">
                    {request.account === null ? null : `${m.wallet_request_account({ account: request.account })} · `}
                    {m.wallet_request_asked()} <RelativeTime value={new Date(request.createdAt)} />
                </span>
                {answerable(request) ? null : (
                    <span className="text-xs text-text-muted">{m.wallet_request_on_server()}</span>
                )}
            </span>
            {canManage ? (
                // On phones the actions take their own line under the words, aligned with them.
                <span className="flex shrink-0 basis-full items-center gap-1 ps-9 sm:ms-auto sm:basis-auto sm:self-center sm:ps-0">
                    {canAnswer ? (
                        <Button size="sm" onClick={onAnswer}>
                            {record === undefined ? m.wallet_add_login() : m.wallet_update()}
                        </Button>
                    ) : null}
                    <ActionMenu
                        label={m.wallet_request_actions({ site: siteName(request.origin) })}
                        variant="ghost"
                        size="sm"
                        items={items}
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
    const loginTarget: LoginDialogTarget | null =
        pending?.kind === 'login'
            ? pending.target
            : (resumedTarget ?? (search.dialog === 'new' && canManage && ready ? {} : null));
    const removing = pending?.kind === 'remove' ? pending.record : undefined;

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
                    {wallet.data.pending.length === 0 ? null : (
                        <Section title={m.wallet_requests_title()} count={wallet.data.pending.length} divided={false}>
                            <ul className="flex flex-col gap-2">
                                {wallet.data.pending.map((request) => {
                                    const record = wallet.data.records.find(({ id }) => id === request.recordId);
                                    return (
                                        <RequestItem
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
                        </Section>
                    )}
                    {ready ? (
                        <Section
                            title={m.wallet_logins_title()}
                            {...(wallet.data.records.length === 0 ? {} : { count: wallet.data.records.length })}
                            divided={wallet.data.pending.length > 0}
                        >
                            {wallet.data.records.length === 0 ? (
                                <EmptyState
                                    variant="inline"
                                    icon={<KeyRound />}
                                    title={m.wallet_empty_title()}
                                    description={m.wallet_empty_body()}
                                />
                            ) : (
                                <ul className="-mt-1 flex flex-col divide-y divide-hairline">
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
                            )}
                        </Section>
                    ) : null}
                    <WalletTrust />
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

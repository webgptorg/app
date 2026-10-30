import type { Session } from '@ptbk/engine-api';
import { Badge, Button, ConfirmDialog, EmptyState, IconButton, Menu, RelativeTime, useToast } from '@ptbk/ui';
import type { MenuEntry } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Ellipsis, LogOut, Monitor, MonitorSmartphone, Smartphone, Tablet } from 'lucide-react';
import { useState } from 'react';

import { unwrap } from '../../app/api-errors';
import { useBrowser } from '../../app/browser-context';
import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { isPageLevelFailure } from '../../app/list-errors';
import { useStepUpAwareMutation } from '../../app/mutations';
import { m } from '../../paraglide/messages';
import { Page } from '../shell/page';
import { signOut } from '../shell/sign-out';
import { FactsSkeleton } from './facts';
import { SectionCard } from './section-card';
import { sessionDevice } from './session-device';
import type { DeviceKind } from './session-device';
import { securityKeys } from './security-keys';
import { CREDENTIALS_PAGE_SIZE, mySessionsQueryOptions } from './security-queries';

const MUTATION_TIMEOUT_MS = 30_000;

const DEVICE_ICONS: Readonly<Record<DeviceKind, typeof Monitor>> = {
    phone: Smartphone,
    tablet: Tablet,
    computer: Monitor,
};

export function deviceLabel(session: Session): string {
    const { browser, os } = sessionDevice(session.client);
    if (browser !== null && os !== null) return m.sessions_device({ browser, os });
    return browser ?? os ?? m.sessions_device_unknown();
}

type Pending =
    | { readonly kind: 'one'; readonly session: Session; readonly label: string }
    | { readonly kind: 'others'; readonly count: number };

interface SessionRowProps {
    readonly session: Session;
    readonly label: string;
    readonly onSignOut: () => void;
}

function SessionRow({ session, label, onSignOut }: SessionRowProps) {
    const Icon = DEVICE_ICONS[sessionDevice(session.client).kind];
    const menuLabel = m.sessions_actions_for({ device: label });
    const items: MenuEntry[] = [
        {
            kind: 'item',
            id: 'sign-out',
            label: session.current ? m.sessions_sign_out_here() : m.sessions_sign_out(),
            icon: <LogOut aria-hidden />,
            tone: 'danger',
            onSelect: onSignOut,
        },
    ];
    return (
        <li className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
            <Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-text-muted" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2 font-medium">
                    {label}
                    {session.current ? <Badge tone="accent">{m.sessions_this_device()}</Badge> : null}
                </span>
                <span className="text-sm break-words text-text-muted">
                    {session.client === null ? null : (
                        <>
                            <span className="tabular-nums">{session.client.ip}</span>
                            {' · '}
                        </>
                    )}
                    {m.sessions_signed_in()} <RelativeTime value={new Date(session.createdAt)} />
                    {session.current ? null : (
                        <>
                            {' · '}
                            {m.sessions_last_active()} <RelativeTime value={new Date(session.lastSeenAt)} />
                        </>
                    )}
                </span>
            </div>
            <Menu
                label={menuLabel}
                align="end"
                items={items}
                trigger={(triggerProps) => (
                    <IconButton
                        {...triggerProps}
                        variant="ghost"
                        size="sm"
                        label={menuLabel}
                        icon={<Ellipsis aria-hidden className="size-4" />}
                    />
                )}
            />
        </li>
    );
}

/**
 * The signed-in member's own sessions, one per browser that signed in with a passkey. Signing one out needs no
 * permission (`/me/sessions`); it fails from that browser's next request.
 */
export function SessionsPage() {
    const engineApi = useEngineApi();
    const browser = useBrowser();
    const toast = useToast();
    const [pending, setPending] = useState<Pending | null>(null);
    const sessions = useQuery({ ...mySessionsQueryOptions(engineApi), throwOnError: isPageLevelFailure });
    const close = () => {
        setPending(null);
    };

    const revokeOne = useStepUpAwareMutation({
        mutationFn: async ({ session }: { readonly session: Session; readonly label: string }) =>
            unwrap(await engineApi.me.revokeSession(session.id, AbortSignal.timeout(MUTATION_TIMEOUT_MS))),
        invalidates: [securityKeys.mySessions()],
        successMessage: (_, { label }) => m.sessions_signed_out({ device: label }),
        errorMessage: (_, { label }) => m.sessions_sign_out_failed({ device: label }),
    });
    const revokeOthers = useStepUpAwareMutation({
        mutationFn: async () =>
            unwrap(await engineApi.me.revokeOtherSessions(AbortSignal.timeout(MUTATION_TIMEOUT_MS))),
        invalidates: [securityKeys.mySessions()],
        successMessage: ({ revoked }) => m.sessions_others_signed_out({ count: revoked }),
        errorMessage: () => m.sessions_others_failed(),
    });

    const signOutHere = () => {
        void signOut(browser).then((signedOut) => {
            if (!signedOut) toast.show({ tone: 'danger', title: m.sign_out_failed() });
        });
    };
    const otherCount = sessions.data?.items.filter(({ current }) => !current).length ?? 0;

    return (
        <Page
            title={m.sessions_title()}
            back={
                <Link to="/security" variant="standalone" className="inline-flex items-center gap-1 text-sm">
                    <ArrowLeft aria-hidden className="size-4" />
                    {m.sessions_back()}
                </Link>
            }
        >
            <p className="text-sm text-text-muted">{m.sessions_intro()}</p>
            <SectionCard title={m.sessions_mine()} query={sessions} skeleton={<FactsSkeleton rows={3} />}>
                {({ items, nextCursor }) => (
                    <div className="flex flex-col gap-4">
                        {items.length === 0 ? (
                            <EmptyState headingLevel={3} icon={<MonitorSmartphone />} title={m.sessions_empty()} />
                        ) : (
                            <ul className="flex flex-col divide-y divide-divider">
                                {items.map((session) => {
                                    const label = deviceLabel(session);
                                    return (
                                        <SessionRow
                                            key={session.id}
                                            session={session}
                                            label={label}
                                            onSignOut={
                                                session.current
                                                    ? signOutHere
                                                    : () => {
                                                          setPending({ kind: 'one', session, label });
                                                      }
                                            }
                                        />
                                    );
                                })}
                            </ul>
                        )}
                        {nextCursor === null ? null : (
                            <p className="text-sm text-text-muted">
                                {m.sessions_more({ count: String(CREDENTIALS_PAGE_SIZE) })}
                            </p>
                        )}
                        {otherCount === 0 ? (
                            <p className="text-sm text-text-muted">{m.sessions_only_this_one()}</p>
                        ) : (
                            <div className="flex flex-col items-start gap-2 border-t border-divider pt-4">
                                <p className="text-sm text-text-muted">{m.sessions_others_hint()}</p>
                                <Button
                                    onClick={() => {
                                        setPending({ kind: 'others', count: otherCount });
                                    }}
                                >
                                    <LogOut aria-hidden className="size-4" />
                                    {m.sessions_sign_out_others()}
                                </Button>
                            </div>
                        )}
                    </div>
                )}
            </SectionCard>
            {pending?.kind === 'one' ? (
                <ConfirmDialog
                    open
                    onClose={close}
                    tone="danger"
                    title={m.sessions_sign_out_title({ device: pending.label })}
                    description={m.sessions_sign_out_body()}
                    confirmLabel={m.sessions_sign_out()}
                    loading={revokeOne.isPending}
                    onConfirm={() => {
                        revokeOne.mutate(pending, { onSuccess: close });
                    }}
                />
            ) : null}
            {pending?.kind === 'others' ? (
                <ConfirmDialog
                    open
                    onClose={close}
                    tone="danger"
                    title={m.sessions_others_title({ count: pending.count })}
                    description={m.sessions_others_body()}
                    confirmLabel={m.sessions_sign_out_others()}
                    loading={revokeOthers.isPending}
                    onConfirm={() => {
                        revokeOthers.mutate(undefined, { onSuccess: close });
                    }}
                />
            ) : null}
        </Page>
    );
}

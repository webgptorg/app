import type { Session } from '@ptbk/engine-api';
import { ActionMenu, Button, ConfirmDialog, EmptyState, RelativeTime, StatusPill, useToast } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { Laptop, LogOut, Monitor, MonitorSmartphone, Smartphone, Tablet } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { unwrap } from '../../app/api-errors';
import { useBrowser } from '../../app/browser-context';
import { useEngineApi } from '../../app/engine-api-context';
import { isPageLevelFailure } from '../../app/list-errors';
import { useStepUpAwareMutation } from '../../app/mutations';
import { m } from '../../paraglide/messages';
import { Crumb, Page } from '../shell/page';
import { signOut } from '../shell/sign-out';
import { FactsSkeleton } from './facts';
import { QuerySection } from './query-section';
import { CredentialRow, MetaDot } from './security-parts';
import { sessionDevice } from './session-device';
import type { SessionDevice } from './session-device';
import { securityKeys } from './security-keys';
import { CREDENTIALS_PAGE_SIZE, mySessionsQueryOptions } from './security-queries';

const MUTATION_TIMEOUT_MS = 30_000;

export type DeviceGlyph = 'laptop' | 'desktop' | 'phone' | 'tablet';

const GLYPHS: Readonly<Record<DeviceGlyph, ReactNode>> = {
    laptop: <Laptop />,
    desktop: <Monitor />,
    phone: <Smartphone />,
    tablet: <Tablet />,
};

/** Macs and Chromebooks are almost always laptops; a Windows or Linux machine may as well be a desktop. */
export function deviceGlyph({ kind, os }: SessionDevice): DeviceGlyph {
    if (kind === 'phone' || kind === 'tablet') return kind;
    return os === 'macOS' || os === 'ChromeOS' ? 'laptop' : 'desktop';
}

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
    return (
        <CredentialRow
            icon={GLYPHS[deviceGlyph(sessionDevice(session.client))]}
            name={label}
            current={session.current ? <StatusPill tone="success">{m.sessions_this_device()}</StatusPill> : undefined}
            meta={
                <>
                    <span>
                        {m.sessions_signed_in()} <RelativeTime value={new Date(session.createdAt)} />
                    </span>
                    {session.current ? null : (
                        <>
                            <MetaDot />
                            <span>
                                {m.sessions_last_active()} <RelativeTime value={new Date(session.lastSeenAt)} />
                            </span>
                        </>
                    )}
                    {session.client === null ? null : (
                        <>
                            <MetaDot />
                            <span className="font-mono">{session.client.ip}</span>
                        </>
                    )}
                </>
            }
            action={
                <ActionMenu
                    label={m.sessions_actions_for({ device: label })}
                    variant="ghost"
                    size="sm"
                    items={[
                        {
                            kind: 'item',
                            id: 'sign-out',
                            label: session.current ? m.sessions_sign_out_here() : m.sessions_sign_out(),
                            icon: <LogOut aria-hidden />,
                            tone: 'danger',
                            onSelect: onSignOut,
                        },
                    ]}
                />
            }
        />
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
            description={m.sessions_intro()}
            breadcrumbs={[
                <Crumb key="security" to="/security">
                    {m.security_title()}
                </Crumb>,
            ]}
        >
            <QuerySection
                title={m.sessions_mine()}
                query={sessions}
                skeleton={<FactsSkeleton rows={3} />}
                count={({ items }) => (items.length > 1 ? items.length : undefined)}
            >
                {({ items, nextCursor }) => (
                    <div className="flex flex-col gap-3">
                        {items.length === 0 ? (
                            <EmptyState
                                variant="inline"
                                headingLevel={3}
                                icon={<MonitorSmartphone />}
                                title={m.sessions_empty()}
                            />
                        ) : (
                            <ul className="flex flex-col divide-y divide-hairline">
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
                            <p className="text-xs text-text-muted">
                                {m.sessions_more({ count: String(CREDENTIALS_PAGE_SIZE) })}
                            </p>
                        )}
                        {otherCount === 0 ? (
                            <p className="text-sm text-text-muted">{m.sessions_only_this_one()}</p>
                        ) : (
                            // The bulk sign-out is for a lost device: findable, but quiet beside the list.
                            <div className="flex flex-col gap-2 border-t border-hairline pt-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                                <p className="text-sm text-text-muted">{m.sessions_others_hint()}</p>
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    className="self-start sm:self-auto"
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
            </QuerySection>
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

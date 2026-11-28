import { buttonClassName, useUiMessages } from '@ptbk/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Bell as BellIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { m } from '../../../paraglide/messages';
import { notificationRoutes } from '../../../shared/api/notification-routes';
import type { RouteResponse } from '../../../shared/api/contract';
import { useApiClient } from '../../api/api-client-context';
import { dataOrThrow, queryKeys } from '../../api/queries';
import { useBrowser } from '../../core/browser';
import { ButtonLink, Link } from '../../core/link';
import { useLocale } from '../../i18n/locale';
import { useSession } from '../session/use-session';
import { bellEntries, bellRenderContext } from './bell-entries';
import type { BellEntry } from './bell-entries';
import { notificationsQuery } from './notification-queries';

type NotificationList = RouteResponse<typeof notificationRoutes.listNotifications>;

const UNSEEN_DOT = 'size-2 rounded-pill bg-(--status-info)';

/**
 * The header's bell: a dot while something is unseen, and a panel with the active organization's open notifications.
 * Opening it marks what it showed as seen. On a phone the panel is a sheet on the bottom edge, near the thumb.
 */
export function NotificationBell() {
    const session = useSession();
    if (!session.activeOrg.permissions.includes('notification.read')) {
        return null;
    }
    return <BellWithPanel canMarkSeen={session.activeOrg.permissions.includes('notification.manage')} />;
}

function BellWithPanel({ canMarkSeen }: { readonly canMarkSeen: boolean }) {
    const api = useApiClient();
    const queryClient = useQueryClient();
    const notifications = useQuery(notificationsQuery(api));
    const buttonRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const panelId = useId();
    const headingId = useId();
    const [open, setOpen] = useState(false);

    const markSeen = useMutation({
        mutationFn: async (ids: readonly string[]) => {
            dataOrThrow(await api.call(notificationRoutes.markNotificationsSeen, { body: { ids: [...ids] } }));
        },
        // The dot goes at once; the refetch afterwards is the truth either way, so a failure needs no word.
        onMutate: (ids) => {
            queryClient.setQueryData<NotificationList>(queryKeys.notifications, (list) =>
                list === undefined
                    ? list
                    : {
                          ...list,
                          notifications: list.notifications.map((row) =>
                              ids.includes(row.id) ? { ...row, seen: true } : row,
                          ),
                      },
            );
        },
        onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.notifications }),
    });

    useEffect(() => {
        const panel = panelRef.current;
        if (panel === null) return;
        // Light dismiss and Esc close the popover natively, and Esc returns focus to the bell; keep state in step.
        const onToggle = (event: Event) => {
            setOpen((event as Event & { newState?: string }).newState === 'open');
        };
        // Not modal: tabbing past the last link moves on through the header, and the panel goes with it.
        const onFocusOut = (event: FocusEvent) => {
            const next = event.relatedTarget;
            if (next instanceof Node && !panel.contains(next) && next !== buttonRef.current) {
                panel.hidePopover();
            }
        };
        panel.addEventListener('toggle', onToggle);
        panel.addEventListener('focusout', onFocusOut);
        return () => {
            panel.removeEventListener('toggle', onToggle);
            panel.removeEventListener('focusout', onFocusOut);
        };
    }, []);

    const rows = notifications.data?.notifications ?? [];
    const unseen = rows.filter((row) => !row.seen).length;

    const show = () => {
        const panel = panelRef.current;
        if (panel === null) return;
        panel.showPopover();
        setOpen(true);
        panel.focus();
        if (canMarkSeen && unseen > 0) {
            markSeen.mutate(rows.map((row) => row.id));
        }
    };
    const hide = () => {
        panelRef.current?.hidePopover();
        setOpen(false);
    };
    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                aria-label={unseen === 0 ? m.notification_bell() : m.notification_bell_unseen({ count: unseen })}
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => {
                    if (open) hide();
                    else show();
                }}
                className={buttonClassName('ghost', 'sm', 'relative size-8 px-0')}
            >
                <BellIcon aria-hidden className="size-4" />
                {unseen === 0 ? null : (
                    <span
                        aria-hidden="true"
                        className={`absolute top-1.5 right-1.5 ring-2 ring-surface ${UNSEEN_DOT}`}
                    />
                )}
            </button>
            <div
                ref={panelRef}
                id={panelId}
                popover="auto"
                role="dialog"
                aria-labelledby={headingId}
                tabIndex={-1}
                className={[
                    // `hidden` until open: an author `display` would otherwise beat the UA's closed-popover rule and
                    // leave the panel over the page, catching clicks.
                    'fixed inset-auto m-0 hidden flex-col overflow-auto p-0 outline-none open:flex',
                    'border border-hairline bg-raised text-text shadow-overlay',
                    'motion-safe:animate-[ptbk-menu-enter_var(--motion-enter)_var(--ease-enter)]',
                    // A phone gets a sheet on the bottom edge; wider screens a panel under the bell, which sits at the
                    // end of the header's centred 64rem column.
                    'inset-x-0 bottom-0 max-h-[80dvh] w-full rounded-t-surface',
                    'sm:top-13 sm:right-[max(1rem,calc((100%-64rem)/2+1rem))] sm:bottom-auto sm:left-auto sm:max-h-[min(32rem,calc(100dvh-4rem))] sm:w-96 sm:rounded-surface',
                ].join(' ')}
            >
                {/* Rendered only while open, so a closed panel puts no lines in the page for anyone to find. */}
                {open ? (
                    <>
                        <h2 id={headingId} className="px-4 pt-3 pb-1 text-sm font-semibold">
                            {m.notification_bell()}
                        </h2>
                        <BellBody
                            entries={notifications.data === undefined ? null : notifications.data.notifications}
                            failed={notifications.isError && notifications.data === undefined}
                            onFollow={hide}
                        />
                        <div className="mt-1 border-t border-hairline p-1">
                            <Link
                                to="/account"
                                hash="notifications"
                                variant="standalone"
                                onClick={hide}
                                className="flex min-h-9 items-center gap-1.5 rounded-small px-3 text-sm text-text-muted no-underline hover:bg-hover hover:text-text"
                            >
                                {m.notification_settings_link()}
                                <ArrowRight aria-hidden className="size-3.5" />
                            </Link>
                        </div>
                    </>
                ) : null}
            </div>
        </>
    );
}

function BellBody(props: {
    readonly entries: NotificationList['notifications'] | null;
    readonly failed: boolean;
    readonly onFollow: () => void;
}) {
    const session = useSession();
    const { locale } = useLocale();
    const { now } = useBrowser();
    if (props.failed) {
        return <p className="px-4 py-3 text-sm text-text-muted">{m.notification_bell_failed()}</p>;
    }
    // Still loading: nothing rather than a spinner, it takes a moment at most.
    if (props.entries === null) {
        return null;
    }
    const entries = bellEntries(props.entries, session.activeOrg.name, bellRenderContext(locale, now()));
    if (entries.length === 0) {
        return <p className="px-4 py-3 text-sm text-text-muted">{m.notification_bell_empty()}</p>;
    }
    return (
        <ul className="flex flex-col px-1">
            {entries.map((entry) => (
                <BellRow key={entry.key} entry={entry} onFollow={props.onFollow} />
            ))}
        </ul>
    );
}

function BellRow({ entry, onFollow }: { readonly entry: BellEntry; readonly onFollow: () => void }) {
    const lineId = useId();
    const ui = useUiMessages();
    const common = { 'aria-describedby': lineId, onClick: onFollow } as const;
    return (
        <li className="flex items-center gap-3 rounded-small px-3 py-2">
            <span className="flex size-2 shrink-0 justify-center">
                {entry.unseen ? <span aria-hidden="true" className={UNSEEN_DOT} /> : null}
            </span>
            <p id={lineId} className="min-w-0 flex-1 text-sm">
                {entry.line}
            </p>
            {entry.target.to === 'project' ? (
                // The project's registered hostname only, as a top-level tab without opener or referrer.
                <a
                    {...common}
                    href={entry.target.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    referrerPolicy="no-referrer"
                    className={buttonClassName('ghost', 'sm')}
                >
                    {m.notification_open()}
                    <span className="sr-only">{` ${ui.opensInNewTab()}`}</span>
                </a>
            ) : entry.target.to === 'engine-page' ? (
                <ButtonLink
                    {...common}
                    to="/engines/$engineId"
                    params={{ engineId: entry.target.engineId }}
                    variant="ghost"
                    size="sm"
                >
                    {m.notification_open()}
                </ButtonLink>
            ) : (
                <ButtonLink {...common} to={entry.target.path} variant="ghost" size="sm">
                    {m.notification_open()}
                </ButtonLink>
            )}
        </li>
    );
}

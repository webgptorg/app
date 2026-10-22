import { Anchor, Badge, Button, Card, EmptyState, ErrorState, SkipLink } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';

import { m } from '../../../paraglide/messages';
import { useApiClient } from '../../api/api-client-context';
import { devEmailsQuery } from '../../api/queries';
import { useBrowser } from '../../core/browser';
import { linkParts } from './link-parts';

const MAIN_ID = 'main-content';
/** New mail shows up without a reload; well inside the outbox route's per-IP rate limit. */
export const MAILBOX_REFRESH_MS = 5_000;

function EmailText(props: { readonly text: string; readonly origin: string }) {
    return (
        <p className="text-sm break-words whitespace-pre-wrap">
            {linkParts(props.text, props.origin).map((part, index) =>
                part.kind === 'link' ? (
                    <Anchor key={index} href={part.href}>
                        {part.href}
                    </Anchor>
                ) : (
                    part.text
                ),
            )}
        </p>
    );
}

/** Dev only (X-06): what the fake email adapter recorded, so sign-up and recovery links can be followed by hand. */
export function DevMailboxPage() {
    const { origin } = useBrowser();
    const emails = useQuery({ ...devEmailsQuery(useApiClient()), refetchInterval: MAILBOX_REFRESH_MS });
    const newestFirst = [...(emails.data ?? [])].reverse();
    return (
        <div className="min-h-dvh bg-surface text-text">
            <SkipLink targetId={MAIN_ID} />
            <main id={MAIN_ID} tabIndex={-1} className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8 outline-none">
                <header className="flex flex-wrap items-start justify-between gap-4">
                    <div className="flex flex-col gap-1">
                        <h1 className="font-display text-2xl font-semibold">{m.dev_mailbox_title()}</h1>
                        <p className="text-sm text-text-muted">{m.dev_mailbox_summary()}</p>
                    </div>
                    <Button
                        variant="secondary"
                        loading={emails.isFetching}
                        onClick={() => {
                            void emails.refetch();
                        }}
                    >
                        {m.dev_mailbox_refresh()}
                    </Button>
                </header>
                {emails.isError ? (
                    <ErrorState
                        message={m.dev_mailbox_load_failed()}
                        retrying={emails.isFetching}
                        onRetry={() => {
                            void emails.refetch();
                        }}
                    />
                ) : newestFirst.length === 0 && !emails.isPending ? (
                    <EmptyState
                        icon={<Inbox aria-hidden />}
                        title={m.dev_mailbox_empty_title()}
                        headingLevel={2}
                        description={m.dev_mailbox_empty_body()}
                    />
                ) : (
                    <ol className="flex flex-col gap-4">
                        {newestFirst.map((email, index) => (
                            <li key={newestFirst.length - index}>
                                <Card as="article" title={email.subject} titleLevel={2}>
                                    <div className="flex flex-col gap-3">
                                        <p className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
                                            <span>{m.dev_mailbox_to({ to: email.to })}</span>
                                            <Badge>{email.template}</Badge>
                                            <Badge>{email.locale}</Badge>
                                        </p>
                                        <EmailText text={email.text} origin={origin} />
                                    </div>
                                </Card>
                            </li>
                        ))}
                    </ol>
                )}
            </main>
        </div>
    );
}

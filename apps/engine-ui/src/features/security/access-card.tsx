import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import { Card, Skeleton } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, MonitorSmartphone, ScrollText } from 'lucide-react';
import type { ReactNode } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { ButtonLink } from '../../app/link';
import { m } from '../../paraglide/messages';
import { useAllows } from '../../app/registry/use-visible-features';
import { CREDENTIALS_PAGE_SIZE, myPasskeysQueryOptions, mySessionsQueryOptions } from './security-queries';

export interface AccessRowProps {
    readonly icon: ReactNode;
    readonly title: string;
    readonly summary: ReactNode;
    /** The way to the screen that manages it, usually a small `ButtonLink`. */
    readonly action: ReactNode;
}

/** One kind of access on the Security page (passkeys, sessions, the audit log): what it is now, and where to manage it. */
export function AccessRow({ icon, title, summary, action }: AccessRowProps) {
    return (
        <li className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center">
            <span className="flex min-w-0 flex-1 items-start gap-3">
                <span aria-hidden className="mt-0.5 inline-flex shrink-0 text-text-muted [&>svg]:size-5">
                    {icon}
                </span>
                <span className="flex min-w-0 flex-col">
                    <span className="font-medium">{title}</span>
                    <span className="text-sm text-text-muted">{summary}</span>
                </span>
            </span>
            <span className="ps-8 sm:ps-0">{action}</span>
        </li>
    );
}

function PasskeysSummary() {
    const mine = useQuery(myPasskeysQueryOptions(useEngineApi(), { limit: CREDENTIALS_PAGE_SIZE }));
    if (mine.data === undefined)
        return mine.isError ? m.security_access_passkeys_hint() : <Skeleton className="h-4 w-32" />;
    return m.security_access_passkeys({ count: mine.data.items.length });
}

function SessionsSummary() {
    const sessions = useQuery(mySessionsQueryOptions(useEngineApi()));
    if (sessions.data === undefined)
        return sessions.isError ? m.security_access_sessions_hint() : <Skeleton className="h-4 w-32" />;
    return m.security_access_sessions({ count: sessions.data.items.length });
}

/** Who can get in, for every member: their own passkeys, and the audit log for those who may read it. */
export function AccessCard() {
    const canOpenAudit = useAllows({ capability: KNOWN_CAPABILITIES.audit, permission: 'audit.read' });
    return (
        <Card title={m.security_access_title()}>
            <ul className="-my-3 flex flex-col divide-y divide-divider">
                <AccessRow
                    icon={<KeyRound />}
                    title={m.passkeys_title()}
                    summary={<PasskeysSummary />}
                    action={
                        <ButtonLink to="/security/passkeys" size="sm">
                            {m.security_access_passkeys_link()}
                        </ButtonLink>
                    }
                />
                <AccessRow
                    icon={<MonitorSmartphone />}
                    title={m.sessions_title()}
                    summary={<SessionsSummary />}
                    action={
                        <ButtonLink to="/security/sessions" size="sm">
                            {m.security_access_sessions_link()}
                        </ButtonLink>
                    }
                />
                {canOpenAudit ? (
                    <AccessRow
                        icon={<ScrollText />}
                        title={m.audit_title()}
                        summary={m.security_access_audit()}
                        action={
                            <ButtonLink to="/audit" size="sm">
                                {m.security_access_audit_open()}
                            </ButtonLink>
                        }
                    />
                ) : null}
            </ul>
        </Card>
    );
}

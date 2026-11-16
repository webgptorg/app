import type { ReadIntegration, ReadSecretRef } from '@ptbk/engine-api';
import { StatusPill } from '@ptbk/ui';
import type { StatusTone } from '@ptbk/ui';
import { CalendarDays, FolderGit2, Plug, Server } from 'lucide-react';
import type { ReactNode } from 'react';

import { m } from '../../paraglide/messages';

/** A status this UI does not know yet (a newer engine's) reads as `unknown`, never as an error. */
export type IntegrationStatusValue = ReadIntegration['status'];

interface Look {
    readonly label: string;
    readonly tone: StatusTone;
}

function statusLook(status: IntegrationStatusValue): Look {
    switch (status) {
        case 'connected':
            return { label: m.integration_status_connected(), tone: 'success' };
        case 'needs-attention':
            return { label: m.integration_status_needs_attention(), tone: 'warning' };
        case 'disconnected':
            return { label: m.integration_status_disconnected(), tone: 'neutral' };
        case 'error':
            return { label: m.integration_status_error(), tone: 'danger' };
        case 'unknown':
            return { label: m.integration_status_unknown(), tone: 'neutral' };
    }
}

export function integrationStatusLabel(status: IntegrationStatusValue): string {
    return statusLook(status).label;
}

export function integrationStatusTone(status: IntegrationStatusValue): StatusTone {
    return statusLook(status).tone;
}

/** The status in words beside its dot, never colour alone. */
export function IntegrationStatusBadge({ status }: { readonly status: IntegrationStatusValue }) {
    const look = statusLook(status);
    return <StatusPill tone={look.tone}>{look.label}</StatusPill>;
}

export function needsAttention(status: IntegrationStatusValue): boolean {
    return status === 'needs-attention' || status === 'error';
}

function secretStateLook(state: ReadSecretRef['state']): Look {
    switch (state) {
        case 'resolved':
            return { label: m.integration_secret_resolved(), tone: 'success' };
        case 'missing':
            return { label: m.integration_secret_missing(), tone: 'warning' };
        case 'revoked':
            return { label: m.integration_secret_revoked(), tone: 'danger' };
        case 'unknown':
            return { label: m.integration_status_unknown(), tone: 'neutral' };
    }
}

export function SecretStateBadge({ state }: { readonly state: ReadSecretRef['state'] }) {
    const look = secretStateLook(state);
    return <StatusPill tone={look.tone}>{look.label}</StatusPill>;
}

/** The kind as the engine named it: `rawKind` for a kind this UI does not know. */
export function kindNameOf(integration: ReadIntegration): string {
    return integration.kind === 'unknown' ? integration.rawKind : integration.kind;
}

/** A kind this UI knows by name; another engine's kind shows as the engine sent it, as text. */
export function integrationKindLabel(kind: string): string {
    switch (kind) {
        case 'mcp-server':
            return m.integration_kind_mcp_server();
        case 'calendar':
            return m.integration_kind_calendar();
        case 'repository':
            return m.integration_kind_repository();
        default:
            return kind;
    }
}

/** A small monochrome mark for the kind. */
export function integrationKindIcon(kind: string): ReactNode {
    switch (kind) {
        case 'mcp-server':
            return <Server />;
        case 'calendar':
            return <CalendarDays />;
        case 'repository':
            return <FolderGit2 />;
        default:
            return <Plug />;
    }
}

/** A scope as a small neutral pill: the provider's own words for an access right, as text. */
export function ScopePill({ scope }: { readonly scope: string }) {
    return (
        <span className="inline-flex h-6 max-w-full items-center rounded-pill bg-neutral-soft px-2 text-xs font-medium text-text">
            <span className="truncate">{scope}</span>
        </span>
    );
}

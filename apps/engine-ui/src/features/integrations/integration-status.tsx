import type { ReadIntegration, ReadSecretRef } from '@ptbk/engine-api';
import { Badge } from '@ptbk/ui';
import type { BadgeTone } from '@ptbk/ui';
import { CircleAlert, CircleCheck, CircleHelp, CircleOff, KeyRound, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

import { m } from '../../paraglide/messages';

/** A status this UI does not know yet (a newer engine's) reads as `unknown`, never as an error. */
export type IntegrationStatusValue = ReadIntegration['status'];

interface Look {
    readonly label: string;
    readonly tone: BadgeTone;
    readonly icon: ReactNode;
}

function statusLook(status: IntegrationStatusValue): Look {
    switch (status) {
        case 'connected':
            return { label: m.integration_status_connected(), tone: 'success', icon: <CircleCheck /> };
        case 'needs-attention':
            return { label: m.integration_status_needs_attention(), tone: 'warning', icon: <TriangleAlert /> };
        case 'disconnected':
            return { label: m.integration_status_disconnected(), tone: 'neutral', icon: <CircleOff /> };
        case 'error':
            return { label: m.integration_status_error(), tone: 'danger', icon: <CircleAlert /> };
        case 'unknown':
            return { label: m.integration_status_unknown(), tone: 'neutral', icon: <CircleHelp /> };
    }
}

export function integrationStatusLabel(status: IntegrationStatusValue): string {
    return statusLook(status).label;
}

/** The status as text with an icon, never colour alone. */
export function IntegrationStatusBadge({ status }: { readonly status: IntegrationStatusValue }) {
    const look = statusLook(status);
    return (
        <Badge tone={look.tone} icon={look.icon}>
            {look.label}
        </Badge>
    );
}

export function needsAttention(status: IntegrationStatusValue): boolean {
    return status === 'needs-attention' || status === 'error';
}

function secretStateLook(state: ReadSecretRef['state']): Look {
    switch (state) {
        case 'resolved':
            return { label: m.integration_secret_resolved(), tone: 'success', icon: <KeyRound /> };
        case 'missing':
            return { label: m.integration_secret_missing(), tone: 'warning', icon: <TriangleAlert /> };
        case 'revoked':
            return { label: m.integration_secret_revoked(), tone: 'danger', icon: <CircleOff /> };
        case 'unknown':
            return { label: m.integration_status_unknown(), tone: 'neutral', icon: <CircleHelp /> };
    }
}

export function SecretStateBadge({ state }: { readonly state: ReadSecretRef['state'] }) {
    const look = secretStateLook(state);
    return (
        <Badge tone={look.tone} icon={look.icon}>
            {look.label}
        </Badge>
    );
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

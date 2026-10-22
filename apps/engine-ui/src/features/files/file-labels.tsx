import { FILE_PURPOSES, FILE_SCAN_STATUSES } from '@ptbk/engine-api';
import type { FilePurpose, FileScanStatus } from '@ptbk/engine-api';
import { Badge } from '@ptbk/ui';
import type { BadgeTone } from '@ptbk/ui';
import { CircleHelp, Hourglass, ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react';
import type { ReactNode } from 'react';

import { m } from '../../paraglide/messages';
import { SCAN_PROBLEMS } from './files-search';

export function purposeLabel(purpose: FilePurpose): string {
    switch (purpose) {
        case 'knowledge':
            return m.files_purpose_knowledge();
        case 'attachment':
            return m.files_purpose_attachment();
        case 'output':
            return m.files_purpose_output();
        case 'upload':
            return m.files_purpose_upload();
    }
}

export function PurposeBadge({ purpose }: { readonly purpose: FilePurpose }) {
    return <Badge tone={purpose === 'knowledge' ? 'accent' : 'neutral'}>{purposeLabel(purpose)}</Badge>;
}

interface ScanLook {
    readonly label: string;
    readonly tone: BadgeTone;
    readonly icon: ReactNode;
}

const KNOWN_SCANS: ReadonlySet<string> = new Set<string>(FILE_SCAN_STATUSES);

function isKnownScan(status: string): status is FileScanStatus {
    return KNOWN_SCANS.has(status);
}

function scanLook(status: FileScanStatus): ScanLook {
    switch (status) {
        case 'pending':
            return { label: m.files_scan_pending(), tone: 'info', icon: <Hourglass /> };
        case 'clean':
            return { label: m.files_scan_clean(), tone: 'success', icon: <ShieldCheck /> };
        case 'infected':
            return { label: m.files_scan_infected(), tone: 'danger', icon: <ShieldX /> };
        case 'failed':
            return { label: m.files_scan_failed(), tone: 'warning', icon: <ShieldAlert /> };
    }
}

export function scanLabel(status: FileScanStatus): string {
    return scanLook(status).label;
}

/** Always text with the icon, never colour alone; a status from a newer engine shows as "unknown" with its value. */
export function ScanBadge({ status }: { readonly status: string }) {
    if (!isKnownScan(status)) {
        return (
            <Badge tone="neutral" icon={<CircleHelp />}>
                {m.files_scan_unknown({ value: status })}
            </Badge>
        );
    }
    const look = scanLook(status);
    return (
        <Badge tone={look.tone} icon={look.icon}>
            {look.label}
        </Badge>
    );
}

export function purposeFilterOptions() {
    return FILE_PURPOSES.map((purpose) => ({ value: purpose, label: purposeLabel(purpose) }));
}

/** Each status, plus the set the attention item links to. */
export function scanFilterOptions() {
    return [
        { value: SCAN_PROBLEMS, label: m.files_scan_problems() },
        ...FILE_SCAN_STATUSES.map((status) => ({ value: status, label: scanLabel(status) })),
    ];
}

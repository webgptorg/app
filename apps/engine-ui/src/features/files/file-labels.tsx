import { FILE_PURPOSES, FILE_SCAN_STATUSES } from '@ptbk/engine-api';
import type { FilePurpose, FileScanStatus } from '@ptbk/engine-api';
import { StatusDot, StatusPill } from '@ptbk/ui';
import type { StatusTone } from '@ptbk/ui';
import { BookOpen, Paperclip, Sparkles, Upload } from 'lucide-react';
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

export function purposeIcon(purpose: FilePurpose): ReactNode {
    switch (purpose) {
        case 'knowledge':
            return <BookOpen />;
        case 'attachment':
            return <Paperclip />;
        case 'output':
            return <Sparkles />;
        case 'upload':
            return <Upload />;
    }
}

/** What a file is for, as a neutral pill: a kind, not a state, so it takes no status hue. */
export function PurposeBadge({ purpose }: { readonly purpose: FilePurpose }) {
    return (
        <span className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-pill bg-neutral-soft px-2 text-xs font-medium whitespace-nowrap text-text">
            <span aria-hidden="true" className="flex text-text-muted [&>svg]:size-3">
                {purposeIcon(purpose)}
            </span>
            {purposeLabel(purpose)}
        </span>
    );
}

const KNOWN_SCANS: ReadonlySet<string> = new Set<string>(FILE_SCAN_STATUSES);

function isKnownScan(status: string): status is FileScanStatus {
    return KNOWN_SCANS.has(status);
}

export function scanLabel(status: FileScanStatus): string {
    switch (status) {
        case 'pending':
            return m.files_scan_pending();
        case 'clean':
            return m.files_scan_clean();
        case 'infected':
            return m.files_scan_infected();
        case 'failed':
            return m.files_scan_failed();
    }
}

export function scanTone(status: FileScanStatus): StatusTone {
    switch (status) {
        case 'pending':
            return 'waiting';
        case 'clean':
            return 'success';
        case 'infected':
            return 'danger';
        case 'failed':
            return 'warning';
    }
}

/** Always in words beside the dot, never colour alone; a status from a newer engine shows as "unknown" with its value. */
export function ScanBadge({ status }: { readonly status: string }) {
    if (!isKnownScan(status)) {
        return <StatusPill tone="neutral">{m.files_scan_unknown({ value: status })}</StatusPill>;
    }
    return <StatusPill tone={scanTone(status)}>{scanLabel(status)}</StatusPill>;
}

export function purposeFilterOptions() {
    return FILE_PURPOSES.map((purpose) => ({ value: purpose, label: purposeLabel(purpose) }));
}

/** Each status, plus the set the attention item links to; for the column filter an agent's Files tab still shows. */
export function scanFilterOptions() {
    return [
        { value: SCAN_PROBLEMS, label: m.files_scan_problems() },
        ...FILE_SCAN_STATUSES.map((status) => ({ value: status, label: scanLabel(status) })),
    ];
}

/** The scan statuses for `FilterBar`, each led by its dot. */
export function scanFieldOptions() {
    return FILE_SCAN_STATUSES.map((status) => ({
        value: status,
        label: scanLabel(status),
        icon: <StatusDot tone={scanTone(status)} />,
    }));
}

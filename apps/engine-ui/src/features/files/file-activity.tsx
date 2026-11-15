import type { Activity } from '@ptbk/engine-api';

import { ActivityLine } from '../entities/activity-line';
import type { ActivityOutcome } from '../entities/activity-line';
import { EntityChip } from '../entities/entity-chip';
import { m } from '../../paraglide/messages';
import { purposeLabel } from './file-labels';

type FileActivity = Extract<Activity, { readonly kind: `file.${string}` }>;

function isFileActivity(activity: Activity): activity is FileActivity {
    return activity.kind.startsWith('file.');
}

/** One line per `file.*` kind (v1). The name is member or agent content and is only ever text. */
export function fileActivitySummary(activity: Activity): string {
    if (!isFileActivity(activity)) return activity.kind;
    switch (activity.kind) {
        case 'file.created':
            return m.files_activity_created({ name: activity.name, purpose: purposeLabel(activity.purpose) });
        case 'file.deleted':
            return m.files_activity_deleted({ name: activity.name });
        case 'file.scan-failed':
            return m.files_activity_scan_failed({ name: activity.name });
    }
}

function fileOutcome(activity: FileActivity): ActivityOutcome {
    switch (activity.kind) {
        case 'file.created':
            return { tone: 'success', label: m.activity_outcome_added() };
        case 'file.deleted':
            return { tone: 'neutral', label: m.activity_outcome_deleted() };
        case 'file.scan-failed':
            return { tone: 'danger', label: m.activity_outcome_scan_failed() };
    }
}

/** A file event as an activity line: the file as a chip (a deleted one has nothing to open), what it is for, the outcome. */
export function FileActivityItem({ activity }: { readonly activity: Activity }) {
    if (!isFileActivity(activity)) return null;
    return (
        <ActivityLine
            activity={activity}
            description={
                <EntityChip
                    kind="file"
                    id={activity.kind === 'file.deleted' ? null : activity.fileId}
                    name={activity.name}
                />
            }
            outcome={fileOutcome(activity)}
            facts={activity.kind === 'file.created' ? purposeLabel(activity.purpose) : null}
        />
    );
}

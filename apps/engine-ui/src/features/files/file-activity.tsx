import type { Activity } from '@ptbk/engine-api';

import { Link } from '../../app/link';
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

/** The home feed's card body for a file event, linking to the file (a deleted one has nothing to open). */
export function FileActivityItem({ activity }: { readonly activity: Activity }) {
    if (!isFileActivity(activity)) return null;
    return (
        <div className="flex flex-col gap-1 text-sm">
            <p className="break-words">{fileActivitySummary(activity)}</p>
            {activity.kind === 'file.deleted' ? null : (
                <Link to="/files" search={{ file: activity.fileId }}>
                    {m.files_activity_open()}
                </Link>
            )}
        </div>
    );
}

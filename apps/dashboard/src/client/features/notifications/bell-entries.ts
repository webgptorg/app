import { createFormatters } from '@ptbk/ui';

import { m } from '../../../paraglide/messages';
import type { NotificationView } from '../../../shared/api/notification-routes';
import type {
    NotificationItem,
    NotificationPlace,
    RenderContext,
} from '../../../shared/notifications/notification-kind';
import { anyKind, isEngineKind, parseVariant } from '../../../shared/notifications/registry';

/** Where a line's Open goes: the dashboard's own pages, or the project's registered hostname, never an item in it. */
export type BellTarget =
    | { readonly to: 'engine-page'; readonly engineId: string }
    | { readonly to: 'dashboard'; readonly path: '/' | '/people' }
    | { readonly to: 'project'; readonly href: string };

export interface BellEntry {
    readonly key: string;
    readonly line: string;
    readonly unseen: boolean;
    readonly target: BellTarget;
}

type Project = NonNullable<NotificationView['project']>;

function targetOf(row: NotificationView): BellTarget {
    const link = anyKind(row.kind).copy.link(itemOf(row));
    const { project } = row;
    switch (link.to) {
        case 'dashboard':
            return { to: 'dashboard', path: link.path };
        case 'project-page':
            return project === null
                ? { to: 'dashboard', path: '/' }
                : { to: 'engine-page', engineId: project.engineId };
        case 'project':
            return project === null ? { to: 'dashboard', path: '/' } : projectTarget(project, link.path);
    }
}

function projectTarget(project: Project, path: '/' | '/members'): BellTarget {
    return { to: 'project', href: `https://${project.hostname}${path}` };
}

/** Only what a kind's copy may read, and a variant of the row's own kind or none: rows are parsed, never trusted. */
function itemOf(row: NotificationView): NotificationItem {
    return {
        count: row.count,
        variant: parseVariant(row.kind, row.variant),
        openedAt: row.openedAt,
        updatedAt: row.updatedAt,
    };
}

function placeOf(row: NotificationView, orgName: string | null): NotificationPlace {
    return {
        orgName,
        project: row.project === null ? null : { label: row.project.label, hostname: row.project.hostname },
    };
}

/**
 * The bell's lines. Every word comes from a kind's copy over what the dashboard owns (kind, variant, count, times, the
 * project's label and hostname, the organization's name): an engine's own text has no field to arrive in. A project's
 * engine counts read as one line, like the email that would carry them, and open the project itself.
 */
export function bellEntries(
    rows: readonly NotificationView[],
    orgName: string | null,
    context: RenderContext,
): BellEntry[] {
    const projects = new Map<string, { readonly project: Project; readonly rows: NotificationView[] }>();
    const slots: ({ readonly row: NotificationView } | { readonly engineId: string })[] = [];
    for (const row of rows) {
        if (!isEngineKind(row.kind) || row.project === null) {
            slots.push({ row });
            continue;
        }
        const group = projects.get(row.project.engineId);
        if (group === undefined) {
            projects.set(row.project.engineId, { project: row.project, rows: [row] });
            slots.push({ engineId: row.project.engineId });
        } else {
            group.rows.push(row);
        }
    }
    return slots.flatMap((slot): BellEntry[] => {
        if ('row' in slot) {
            const { row } = slot;
            const line = anyKind(row.kind).copy.line(itemOf(row), placeOf(row, orgName), context);
            return [{ key: row.id, line, unseen: !row.seen, target: targetOf(row) }];
        }
        const group = projects.get(slot.engineId);
        const [only, ...more] = group?.rows ?? [];
        if (group === undefined || only === undefined) {
            return [];
        }
        const line =
            more.length === 0
                ? anyKind(only.kind).copy.line(itemOf(only), placeOf(only, orgName), context)
                : m.notification_things_line(
                      { count: group.rows.reduce((sum, row) => sum + row.count, 0), place: group.project.label },
                      { locale: context.locale },
                  );
        return [
            {
                key: `project-${slot.engineId}`,
                line,
                unseen: group.rows.some((row) => !row.seen),
                target: projectTarget(group.project, '/'),
            },
        ];
    });
}

function sameDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Times in the browser's own zone: "10:42" today, with the day before that, so "since" never misleads. */
export function bellRenderContext(locale: 'en' | 'cs', now: number): RenderContext {
    const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
    const dayAndTime = new Intl.DateTimeFormat(locale, {
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
    });
    const today = new Date(now);
    const formatters = createFormatters(locale);
    return {
        locale,
        time: (ms) => (sameDay(new Date(ms), today) ? time.format(ms) : dayAndTime.format(ms)),
        duration: (ms) => formatters.formatDuration(ms),
    };
}

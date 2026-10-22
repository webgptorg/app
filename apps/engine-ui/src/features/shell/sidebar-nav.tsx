import { cx } from '../../app/cx';
import { Link } from '../../app/link';
import { useVisibleFeatures } from '../../app/registry/use-visible-features';
import type { NavGroup } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';
import { navSections } from './nav-groups';

const GROUP_LABELS: Readonly<Record<NavGroup, () => string>> = {
    work: m.nav_group_work,
    resources: m.nav_group_resources,
    admin: m.nav_group_admin,
};

export interface SidebarNavProps {
    /** Icons only; labels stay in the accessible name. */
    readonly collapsed?: boolean;
    /** Called after a link is followed, e.g. to close the drawer. */
    readonly onNavigate?: () => void;
}

/** The registry's navigation entries the member may use, grouped as docs/design/ui.md orders them. */
export function SidebarNav({ collapsed = false, onNavigate }: SidebarNavProps) {
    const sections = navSections(useVisibleFeatures());
    return (
        <nav aria-label={m.nav_main()} className="flex flex-col gap-5">
            {sections.map((section) => {
                const headingId = `nav-group-${section.group}`;
                return (
                    <div key={section.group} className="flex flex-col gap-1">
                        <h2
                            id={headingId}
                            className={cx(
                                'px-3 text-xs font-semibold tracking-wide text-text-muted uppercase',
                                collapsed && 'sr-only',
                            )}
                        >
                            {GROUP_LABELS[section.group]()}
                        </h2>
                        <ul aria-labelledby={headingId} className="flex flex-col gap-0.5">
                            {section.items.map((item) => {
                                const Icon = item.icon;
                                const label = item.label();
                                return (
                                    <li key={item.featureId}>
                                        <Link
                                            to={item.to}
                                            // Every path starts with `/`, so Home is current only on itself.
                                            activeOptions={{ exact: item.to === '/' }}
                                            variant="standalone"
                                            onClick={onNavigate}
                                            title={collapsed ? label : undefined}
                                            className={cx(
                                                'flex min-h-10 items-center gap-3 rounded-control px-3 text-sm font-medium text-text no-underline hover:bg-hover',
                                                'motion-safe:transition-colors motion-safe:duration-(--motion-state)',
                                                'aria-[current=page]:bg-selected aria-[current=page]:text-accent-text',
                                                collapsed && 'justify-center px-0',
                                            )}
                                        >
                                            <Icon aria-hidden className="size-5 shrink-0" />
                                            <span className={collapsed ? 'sr-only' : 'truncate'}>{label}</span>
                                        </Link>
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                );
            })}
        </nav>
    );
}

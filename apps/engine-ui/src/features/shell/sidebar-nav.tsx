import { cx } from '../../app/cx';
import { Link } from '../../app/link';
import { useVisibleFeatures } from '../../app/registry/use-visible-features';
import type { NavGroup } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';
import { useCollapsedNavLabel } from './collapsed-nav-label';
import { navSections } from './nav-groups';

const GROUP_LABELS: Readonly<Record<NavGroup, () => string>> = {
    work: m.nav_group_work,
    resources: m.nav_group_resources,
    admin: m.nav_group_admin,
};

export interface SidebarNavProps {
    /** Icons only; labels stay in the accessible name and show beside the icon on hover and focus. */
    readonly collapsed?: boolean;
    /** Called after a link is followed, e.g. to close the drawer. */
    readonly onNavigate?: () => void;
}

/**
 * The registry's navigation entries the member may use, grouped as docs/design/ui.md orders them. Group names label
 * their lists rather than being headings, so the page's `h1` comes first in the heading outline.
 */
export function SidebarNav({ collapsed = false, onNavigate }: SidebarNavProps) {
    const sections = navSections(useVisibleFeatures());
    const label = useCollapsedNavLabel(collapsed);
    return (
        <nav aria-label={m.nav_main()} className={cx('flex flex-col', collapsed ? 'gap-2' : 'gap-3')}>
            {sections.map((section, index) => {
                const headingId = `nav-group-${section.group}`;
                return (
                    <div
                        key={section.group}
                        className={cx(
                            'flex flex-col gap-0.5',
                            collapsed && index > 0 && 'border-t border-divider pt-2',
                        )}
                    >
                        <span
                            id={headingId}
                            className={cx(
                                'px-3 pb-0.5 text-xs font-semibold tracking-wide text-text-muted uppercase',
                                collapsed && 'sr-only',
                            )}
                        >
                            {GROUP_LABELS[section.group]()}
                        </span>
                        <ul aria-labelledby={headingId} className="flex flex-col gap-0.5">
                            {section.items.map((item) => {
                                const Icon = item.icon;
                                const text = item.label();
                                return (
                                    <li key={item.featureId}>
                                        <Link
                                            to={item.to}
                                            // Every path starts with `/`, so Home is current only on itself.
                                            activeOptions={{ exact: item.to === '/' }}
                                            variant="standalone"
                                            onClick={onNavigate}
                                            {...label.target(text)}
                                            className={cx(
                                                'flex min-h-9 items-center gap-3 rounded-control px-3 text-sm font-medium text-text no-underline hover:bg-hover',
                                                // Inset, so the scrolling nav doesn't clip the ring.
                                                'focus-visible:-outline-offset-2',
                                                'motion-safe:transition-colors motion-safe:duration-(--motion-state)',
                                                'aria-[current=page]:bg-selected aria-[current=page]:text-accent-text',
                                                collapsed && 'justify-center px-0',
                                            )}
                                        >
                                            <Icon aria-hidden className="size-5 shrink-0" />
                                            <span className={collapsed ? 'sr-only' : 'truncate'}>{text}</span>
                                        </Link>
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                );
            })}
            {label.element}
        </nav>
    );
}

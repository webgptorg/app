import { cx } from '../../app/cx';
import { Link } from '../../app/link';
import { useVisibleFeatures } from '../../app/registry/use-visible-features';
import type { NavGroup } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';
import { useCollapsedNavLabel } from './collapsed-nav-label';
import { navSections } from './nav-groups';
import type { NavItem } from './nav-groups';

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

/** Calls the entry's own count hook; one component per entry keeps the rules of hooks. */
function NavBadge({
    useBadge,
    collapsed,
}: {
    readonly useBadge: NonNullable<NavItem['useBadge']>;
    readonly collapsed: boolean;
}) {
    const count = useBadge();
    if (count <= 0) return null;
    const text = m.nav_badge_waiting({ count });
    if (collapsed) {
        return (
            <span className="absolute top-1 right-1 size-1.5 rounded-pill bg-text-muted">
                <span className="sr-only">{text}</span>
            </span>
        );
    }
    return (
        <span className="ms-auto text-xs font-medium text-text-muted tabular-nums">
            <span aria-hidden="true">{count}</span>
            <span className="sr-only">{text}</span>
        </span>
    );
}

/**
 * The registry's navigation entries the member may use, grouped as docs/design/ui.md orders them. Group names label
 * their lists rather than being headings, so the page's `h1` comes first in the heading outline.
 */
export function SidebarNav({ collapsed = false, onNavigate }: SidebarNavProps) {
    const sections = navSections(useVisibleFeatures());
    const label = useCollapsedNavLabel(collapsed);
    return (
        <nav aria-label={m.nav_main()} className={cx('flex flex-col', collapsed ? 'gap-2' : 'gap-5')}>
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
                            className={cx('px-2.5 pb-1 text-xs font-medium text-text-muted', collapsed && 'sr-only')}
                        >
                            {GROUP_LABELS[section.group]()}
                        </span>
                        <ul aria-labelledby={headingId} className="flex flex-col gap-px">
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
                                                'group/nav flex min-h-8 items-center gap-2.5 rounded-control px-2.5 text-sm text-text-muted no-underline pointer-coarse:min-h-10',
                                                'hover:bg-hover hover:text-text',
                                                // Inset, so the scrolling nav doesn't clip the ring.
                                                'focus-visible:-outline-offset-2',
                                                'motion-safe:transition-colors motion-safe:duration-(--motion-state)',
                                                // A quiet wash and full-strength text mark the page; no accent fill.
                                                'aria-[current=page]:bg-selected aria-[current=page]:font-medium aria-[current=page]:text-text',
                                                collapsed && 'relative min-h-9 justify-center px-0',
                                            )}
                                        >
                                            <Icon
                                                aria-hidden
                                                className="size-4 shrink-0 opacity-80 group-aria-[current=page]/nav:opacity-100"
                                            />
                                            <span className={collapsed ? 'sr-only' : 'truncate'}>{text}</span>
                                            {item.useBadge === undefined ? null : (
                                                <NavBadge useBadge={item.useBadge} collapsed={collapsed} />
                                            )}
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

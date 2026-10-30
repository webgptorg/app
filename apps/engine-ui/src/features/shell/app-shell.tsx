import { Drawer, IconButton, SkipLink } from '@ptbk/ui';
import { Outlet } from '@tanstack/react-router';
import { Menu as MenuIcon, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useState } from 'react';

import { useBrowser } from '../../app/browser-context';
import { cx } from '../../app/cx';
import { m } from '../../paraglide/messages';
import { FeatureEventSync } from './feature-event-sync';
import { ShellEngineSwitcher } from './shell-engine-switcher';
import { ShellLanguageSwitch } from './shell-language-switch';
import { LiveIndicator } from './live-indicator';
import { NavScroller } from './nav-scroller';
import { persistSidebarCollapsed, readSidebarCollapsed } from './sidebar-preference';
import { SidebarNav } from './sidebar-nav';
import { NARROW_QUERY, useMediaQuery } from './use-media-query';
import { CommandPaletteHost, PaletteButton, useCommandPalette } from './palette/palette-launcher';
import { UserMenu } from './user-menu';

const MAIN_ID = 'main-content';

/**
 * The authenticated frame around every route: the sidebar (engine switcher with the trust mark, the language switch,
 * navigation from the feature registry, live indicator, user menu), which collapses to icons on wide screens and becomes a drawer below
 * 768 px.
 */
export function AppShell() {
    const narrow = useMediaQuery(NARROW_QUERY);
    const palette = useCommandPalette();
    return (
        <div className={cx('flex min-h-dvh', narrow && 'flex-col pt-14')}>
            <SkipLink targetId={MAIN_ID} />
            <FeatureEventSync />
            {narrow ? (
                <NarrowShell onOpenPalette={palette.openPalette} />
            ) : (
                <WideSidebar onOpenPalette={palette.openPalette} />
            )}
            <CommandPaletteHost state={palette} />
            {/* `--main-fill-height`: the viewport minus the narrow top bar and this padding, for screens that fit it. */}
            <main
                id={MAIN_ID}
                tabIndex={-1}
                className={cx(
                    'min-w-0 flex-1 px-4 py-6 outline-none md:px-8 md:py-8',
                    '[--main-fill-height:calc(100dvh-6.5rem)] md:[--main-fill-height:calc(100dvh-4rem)]',
                )}
            >
                <div className="mx-auto w-full max-w-6xl">
                    <Outlet />
                </div>
            </main>
        </div>
    );
}

function WideSidebar({ onOpenPalette }: { readonly onOpenPalette: () => void }) {
    const { storage } = useBrowser();
    const [collapsed, setCollapsed] = useState(() => readSidebarCollapsed(storage));
    const toggle = () => {
        setCollapsed((previous) => {
            persistSidebarCollapsed(storage, !previous);
            return !previous;
        });
    };
    return (
        <aside
            className={cx(
                'sticky top-0 flex h-dvh shrink-0 flex-col gap-3 border-e border-divider bg-raised p-3',
                'motion-safe:transition-[width] motion-safe:duration-(--motion-enter) motion-safe:ease-enter',
                collapsed ? 'w-18' : 'w-64',
            )}
        >
            <div className={cx('flex gap-1', collapsed ? 'flex-col items-center' : 'items-center')}>
                <div className={cx(!collapsed && 'min-w-0 flex-1')}>
                    <ShellEngineSwitcher compact={collapsed} />
                </div>
                <ShellLanguageSwitch align={collapsed ? 'start' : 'end'} />
            </div>
            <div className={cx(collapsed && 'flex justify-center')}>
                <PaletteButton onOpen={onOpenPalette} compact={collapsed} />
            </div>
            <NavScroller>
                <SidebarNav collapsed={collapsed} />
            </NavScroller>
            <div className={cx('flex flex-col', collapsed && 'items-center')}>
                <LiveIndicator compact={collapsed} className={cx('mb-2', !collapsed && 'px-2')} />
                <div className={cx('flex gap-1', collapsed ? 'flex-col items-center' : 'items-center')}>
                    <div className={cx(!collapsed && 'min-w-0 flex-1')}>
                        <UserMenu compact={collapsed} />
                    </div>
                    <IconButton
                        variant="ghost"
                        size="sm"
                        label={collapsed ? m.sidebar_expand() : m.sidebar_collapse()}
                        aria-expanded={!collapsed}
                        icon={collapsed ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
                        onClick={toggle}
                    />
                </div>
            </div>
        </aside>
    );
}

function NarrowShell({ onOpenPalette }: { readonly onOpenPalette: () => void }) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <header className="fixed inset-x-0 top-0 z-10 flex h-14 items-center gap-2 border-b border-divider bg-raised px-2">
                <IconButton
                    variant="ghost"
                    label={m.sidebar_open()}
                    icon={<MenuIcon aria-hidden />}
                    aria-expanded={open}
                    onClick={() => {
                        setOpen(true);
                    }}
                />
                <div className="min-w-0 flex-1">
                    <ShellEngineSwitcher compact={false} />
                </div>
                <LiveIndicator compact />
                <ShellLanguageSwitch />
                <PaletteButton onOpen={onOpenPalette} compact />
            </header>
            <Drawer
                open={open}
                onClose={() => {
                    setOpen(false);
                }}
                title={m.nav_drawer_title()}
                side="start"
            >
                <div className="flex flex-col gap-4">
                    <SidebarNav
                        onNavigate={() => {
                            setOpen(false);
                        }}
                    />
                    <UserMenu
                        onNavigate={() => {
                            setOpen(false);
                        }}
                    />
                </div>
            </Drawer>
        </>
    );
}

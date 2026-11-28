import { BrandLockup, BrandMark, Button, Drawer, IconButton, SkipLink, useToast } from '@ptbk/ui';
import { Outlet, useMatches } from '@tanstack/react-router';
import { LogOut, Menu as MenuIcon, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useState } from 'react';

import { useBrowser } from '../../app/browser-context';
import { cx } from '../../app/cx';
import { m } from '../../paraglide/messages';
import { useSetupOnly } from '../onboarding/setup-only';
import { FeatureEventSync } from './feature-event-sync';
import { ShellEngineSwitcher } from './shell-engine-switcher';
import { ShellLanguageSwitch } from './shell-language-switch';
import { LiveBrowserSlot } from './live-browser-slot';
import { UiReloadSlot } from './ui-reload-slot';
import { LiveIndicator } from './live-indicator';
import { NavScroller } from './nav-scroller';
import { useSidebarState } from './sidebar-preference';
import type { SidebarState } from './sidebar-preference';
import { SidebarNav } from './sidebar-nav';
import { NARROW_QUERY, useMediaQuery } from './use-media-query';
import { CommandPaletteHost, PaletteButton, useCommandPalette } from './palette/palette-launcher';
import { signOut } from './sign-out';
import { UserMenu } from './user-menu';

const MAIN_ID = 'main-content';

/**
 * The authenticated frame around every route: the sidebar (the Promptbook lockup, the engine switcher with the trust
 * mark, the language switch, navigation from the feature registry, live indicator, user menu), which collapses to icons
 * on wide screens and becomes a drawer below 768 px. An engine that is only being set up gets the setup frame instead.
 */
export function AppShell() {
    return useSetupOnly() ? <SetupShell /> : <FullShell />;
}

/**
 * The frame while setup is all the engine has: who it is and how to leave, but no navigation, palette or live
 * updates, since every other page would be empty until the engine has a project.
 */
function SetupShell() {
    const browser = useBrowser();
    const toast = useToast();
    return (
        <div className="flex min-h-dvh flex-col">
            <SkipLink targetId={MAIN_ID} />
            <header className="flex h-14 items-center gap-3 border-b border-divider bg-surface px-4 md:px-8">
                <BrandLockup className="hidden sm:flex" />
                <BrandMark className="sm:hidden" />
                <div className="min-w-0 sm:w-60">
                    <ShellEngineSwitcher compact={false} />
                </div>
                <div className="ms-auto flex items-center gap-1">
                    <ShellLanguageSwitch />
                    <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => {
                            void signOut(browser).then((signedOut) => {
                                if (!signedOut) toast.show({ tone: 'danger', title: m.sign_out_failed() });
                            });
                        }}
                    >
                        <LogOut aria-hidden className="size-4" />
                        {/* The icon alone on a phone, so the engine's name stays readable beside it. */}
                        <span className="max-sm:sr-only">{m.sign_out()}</span>
                    </Button>
                </div>
            </header>
            <main
                id={MAIN_ID}
                tabIndex={-1}
                className="min-w-0 flex-1 px-4 pt-3 pb-10 outline-none md:px-8 md:pt-4 md:pb-12"
            >
                <div className="mx-auto w-full max-w-page">
                    <Outlet />
                </div>
            </main>
        </div>
    );
}

function FullShell() {
    const narrow = useMediaQuery(NARROW_QUERY);
    const palette = useCommandPalette();
    const sidebar = useSidebarState();
    // A chat or the book fits the screen exactly and scrolls inside itself, so the document never gets a second
    // scrollbar; every other screen grows with its content and the document scrolls.
    const fill = useMatches({ select: (matches) => matches.some((match) => match.staticData.fillViewport === true) });
    return (
        <div className={cx('flex', fill ? 'h-dvh' : 'min-h-dvh', narrow && 'flex-col pt-14')}>
            <SkipLink targetId={MAIN_ID} />
            <FeatureEventSync />
            {narrow ? (
                <NarrowShell onOpenPalette={palette.openPalette} />
            ) : (
                <WideSidebar sidebar={sidebar} onOpenPalette={palette.openPalette} />
            )}
            <CommandPaletteHost state={palette} sidebar={narrow ? null : sidebar} />
            <main
                id={MAIN_ID}
                tabIndex={-1}
                className={cx(
                    'min-w-0 flex-1 px-4 pt-3 outline-none md:px-8 md:pt-4',
                    fill ? 'flex min-h-0 flex-col pb-2 md:pb-3' : 'pb-10 md:pb-12',
                )}
            >
                {/* Lists and tables use the screen; only very wide screens cap it, so rows stay scannable. Prose
                    keeps its own reading width (`Page`'s `width="reading"`, the chat column). */}
                <div className={cx('mx-auto w-full max-w-page', fill && 'flex min-h-0 flex-1 flex-col')}>
                    <UiReloadSlot />
                    <LiveBrowserSlot />
                    <Outlet />
                </div>
            </main>
        </div>
    );
}

function WideSidebar({
    sidebar: { collapsed, toggle },
    onOpenPalette,
}: {
    readonly sidebar: SidebarState;
    readonly onOpenPalette: () => void;
}) {
    return (
        <aside
            className={cx(
                'sticky top-0 flex h-dvh shrink-0 flex-col gap-3 border-e border-divider bg-surface px-2 py-3',
                'motion-safe:transition-[width] motion-safe:duration-(--motion-enter) motion-safe:ease-enter',
                collapsed ? 'w-16' : 'w-60',
            )}
        >
            <div className={cx('flex', collapsed && 'justify-center')}>
                {collapsed ? <BrandMark /> : <BrandLockup />}
            </div>
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
            <header className="fixed inset-x-0 top-0 z-20 flex h-14 items-center gap-2 border-b border-divider bg-surface px-2">
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
                    <BrandLockup />
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

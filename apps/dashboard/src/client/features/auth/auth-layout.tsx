import { Card, IconButton, Menu, SkipLink } from '@ptbk/ui';
import { Outlet } from '@tanstack/react-router';
import { Settings2 } from 'lucide-react';

import { m } from '../../../paraglide/messages';
import { usePreferenceEntries } from '../shell/preference-entries';

const MAIN_ID = 'main-content';

/** The signed-out frame around sign-in, sign-up and recovery: the brand, language and theme, one card. */
export function AuthLayout() {
    const preferences = usePreferenceEntries();
    return (
        <div className="flex min-h-dvh flex-col bg-surface text-text">
            <SkipLink targetId={MAIN_ID} />
            <header className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-4 py-3">
                <span className="font-display text-lg font-semibold">{m.app_name()}</span>
                <Menu
                    label={m.preferences_menu()}
                    align="end"
                    items={preferences}
                    trigger={(props) => (
                        <IconButton
                            {...props}
                            variant="ghost"
                            label={m.preferences_menu()}
                            icon={<Settings2 aria-hidden />}
                        />
                    )}
                />
            </header>
            <main
                id={MAIN_ID}
                tabIndex={-1}
                className="flex flex-1 items-start justify-center px-4 py-8 outline-none md:py-16"
            >
                <Card as="div" className="w-full max-w-md">
                    <Outlet />
                </Card>
            </main>
        </div>
    );
}

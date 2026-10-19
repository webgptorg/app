import type { ReactNode } from 'react';

import { m } from '../../../paraglide/messages';
import { EnvironmentBadge } from './environment-badge';
import { LanguageSwitcher } from './language-switcher';

/** Plain Tailwind until `@ptbk/ui` components are adopted with the first screens (D-09). */
export function AppShell(props: { readonly children: ReactNode }) {
    return (
        <div className="flex min-h-screen flex-col bg-neutral-50 text-neutral-900">
            <header className="flex flex-wrap items-center justify-between gap-4 border-b border-neutral-200 bg-white px-4 py-3">
                <div className="flex items-center gap-3">
                    <span className="text-lg font-semibold">{m.app_name()}</span>
                    <EnvironmentBadge />
                </div>
                <LanguageSwitcher />
            </header>
            <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{props.children}</main>
        </div>
    );
}

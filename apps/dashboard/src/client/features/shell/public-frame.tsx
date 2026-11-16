import { useLocation } from '@tanstack/react-router';

import { m } from '../../../paraglide/messages';
import { HeaderLanguageSwitch } from './language-switch';
import { Crumb } from './page';
import { ThemeMenu } from './theme-menu';

const WIDTH = { narrow: 'max-w-3xl', wide: 'max-w-5xl' } as const;

/** Brand, language and theme for the pages anyone can open signed out: sign-in, sign-up, recovery, trust and abuse. */
export function PublicHeader(props: { readonly width: 'narrow' | 'wide' }) {
    return (
        <header className={`mx-auto flex w-full items-center justify-between gap-4 px-4 py-2.5 ${WIDTH[props.width]}`}>
            <span className="flex items-center gap-2 text-sm font-semibold">
                <img src="/favicon.svg" alt="" className="size-6 shrink-0 rounded-small" />
                {m.app_name()}
            </span>
            <div className="flex items-center gap-1">
                <HeaderLanguageSwitch />
                <ThemeMenu />
            </div>
        </header>
    );
}

const FOOTER_LINKS = [
    { to: '/trust', label: m.trust_link },
    { to: '/abuse', label: m.abuse_title },
] as const;

/** Only pages that exist, and never the page it sits on; privacy and terms join when they do. */
export function PublicFooter(props: { readonly width: 'narrow' | 'wide' }) {
    const pathname = useLocation({ select: (location) => location.pathname });
    return (
        <footer className={`mx-auto w-full px-4 py-6 text-xs ${WIDTH[props.width]}`}>
            <nav aria-label={m.public_footer_label()}>
                <ul className="flex flex-wrap justify-center gap-x-6 gap-y-2">
                    {FOOTER_LINKS.filter(({ to }) => to !== pathname).map(({ to, label }) => (
                        <li key={to}>
                            <Crumb to={to}>{label()}</Crumb>
                        </li>
                    ))}
                </ul>
            </nav>
        </footer>
    );
}

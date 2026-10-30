import { m } from '../../../paraglide/messages';
import { Link } from '../../core/link';
import { HeaderLanguageSwitch } from './language-switch';
import { ThemeMenu } from './theme-menu';

/** Brand, language and theme for the pages anyone can open signed out: sign-in, sign-up, recovery, trust and abuse. */
export function PublicHeader(props: { readonly width: 'narrow' | 'wide' }) {
    return (
        <header
            className={`mx-auto flex w-full items-center justify-between gap-4 px-4 py-3 ${props.width === 'wide' ? 'max-w-5xl' : 'max-w-3xl'}`}
        >
            <span className="font-display text-lg font-semibold">{m.app_name()}</span>
            <div className="flex items-center gap-1">
                <HeaderLanguageSwitch />
                <ThemeMenu />
            </div>
        </header>
    );
}

/** Only pages that exist; privacy and terms join when they do. */
export function PublicFooter(props: { readonly width: 'narrow' | 'wide' }) {
    return (
        <footer
            className={`mx-auto w-full px-4 py-6 text-sm text-text-muted ${props.width === 'wide' ? 'max-w-5xl' : 'max-w-3xl'}`}
        >
            <nav aria-label={m.public_footer_label()}>
                <ul className="flex flex-wrap justify-center gap-x-6 gap-y-2">
                    <li>
                        <Link to="/trust" variant="standalone">
                            {m.trust_link()}
                        </Link>
                    </li>
                    <li>
                        <Link to="/abuse" variant="standalone">
                            {m.abuse_title()}
                        </Link>
                    </li>
                </ul>
            </nav>
        </footer>
    );
}

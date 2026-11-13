import { Menu, Monogram, useToast } from '@ptbk/ui';
import type { MenuEntry } from '@ptbk/ui';
import { LogOut } from 'lucide-react';

import { m } from '../../../paraglide/messages';
import { useSignOut } from '../session/end-session';
import { useSession } from '../session/use-session';
import { useThemeEntries } from './preference-entries';

/** The signed-in person's email, theme and sign-out; the language has its own control in the header. */
export function UserMenu() {
    const session = useSession();
    const signOut = useSignOut();
    const toast = useToast();
    const items: MenuEntry[] = [
        { kind: 'heading', id: 'account', label: session.user.email },
        {
            kind: 'item',
            id: 'website-licenses',
            label: m.website_licenses(),
            onSelect: () => window.location.assign('https://www.ptbk.io/cs/pricing/predplatne'),
        },
        { kind: 'separator', id: 'preferences-separator' },
        ...useThemeEntries(),
        { kind: 'separator', id: 'sign-out-separator' },
        {
            kind: 'item',
            id: 'sign-out',
            label: m.sign_out(),
            icon: <LogOut aria-hidden />,
            onSelect: () => {
                void signOut().then((signedOut) => {
                    // The sign-in page looks the same as before signing in; on a shared machine, this confirms it.
                    toast.show(
                        signedOut
                            ? { tone: 'success', title: m.signed_out() }
                            : { tone: 'danger', title: m.sign_out_failed() },
                    );
                });
            },
        },
    ];
    return (
        <Menu
            label={m.user_menu()}
            align="end"
            items={items}
            trigger={(props) => (
                <button
                    {...props}
                    type="button"
                    aria-label={m.user_menu_for({ email: session.user.email })}
                    className="flex cursor-pointer items-center rounded-pill p-1 hover:bg-hover motion-safe:transition-colors motion-safe:duration-(--motion-state)"
                >
                    {/* The email is the menu's heading; beside the avatar it only truncated. */}
                    <Monogram name={session.user.email} />
                </button>
            )}
        />
    );
}

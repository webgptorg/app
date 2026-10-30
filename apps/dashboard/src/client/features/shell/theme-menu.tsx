import { IconButton, Menu } from '@ptbk/ui';
import { SunMoon } from 'lucide-react';

import { m } from '../../../paraglide/messages';
import { useThemeEntries } from './preference-entries';

/** The signed-out pages' theme choice; signed in, it sits in the user menu. */
export function ThemeMenu() {
    return (
        <Menu
            label={m.theme_label()}
            align="end"
            items={useThemeEntries()}
            trigger={(props) => (
                <IconButton {...props} variant="ghost" label={m.theme_label()} icon={<SunMoon aria-hidden />} />
            )}
        />
    );
}

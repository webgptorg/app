import { Ellipsis } from 'lucide-react';

import { useUiMessages } from '../../i18n/ui-provider';
import type { ButtonSize, ButtonVariant } from '../button/button';
import { IconButton } from '../icon-button/icon-button';
import { Menu } from '../menu/menu';
import type { MenuEntry } from '../menu/menu';

export interface ActionMenuProps {
    readonly items: readonly MenuEntry[];
    /** The trigger's and the menu's accessible name; defaults to "More actions". Name the object in a list of them. */
    readonly label?: string;
    readonly align?: 'start' | 'end';
    readonly size?: ButtonSize;
    /** `secondary` sits beside a page header's buttons; `ghost` suits rows, cards and drawers. */
    readonly variant?: ButtonVariant;
}

/**
 * The "More" (⋯) overflow next to an object's primary actions, and the one home of its destructive actions.
 *
 * - Delete, Revoke, Remove and the like go here as `tone: 'danger'` items (red text), after a separator, never as a
 *   filled red button beside the primary actions. The filled danger button belongs only in the confirm dialog that
 *   names the object.
 * - The same in page headers, drawers and the phone sticky action bar.
 * - Keep the one or two actions people use most as buttons; everything else goes in the menu.
 *
 * Renders nothing when no entry is actionable, so callers can filter by permission without a guard.
 */
export function ActionMenu({ items, label, align = 'end', size = 'md', variant = 'secondary' }: ActionMenuProps) {
    const messages = useUiMessages();
    if (!items.some((entry) => entry.kind === 'item' || entry.kind === 'link')) return null;
    const name = label ?? messages.moreActions();
    return (
        <Menu
            label={name}
            align={align}
            items={items}
            trigger={(triggerProps) => (
                <IconButton
                    {...triggerProps}
                    variant={variant}
                    size={size}
                    label={name}
                    icon={<Ellipsis aria-hidden="true" className="size-4" />}
                />
            )}
        />
    );
}

import { cx } from './cx';

/**
 * One height for every control that can sit on a line with another: `Button`, `Input`, `Select`, `Textarea` (one row),
 * `Combobox` and `DateInput`. 36px, and 32px where a control has a compact size.
 */
export const CONTROL_HEIGHT = { sm: 'min-h-8', md: 'min-h-9' } as const;

/** On a touch screen the same controls grow to a fingertip, 44px and 40px compact, so a phone needs no precise taps. */
export const TOUCH_HEIGHT = { sm: 'pointer-coarse:min-h-10', md: 'pointer-coarse:min-h-11' } as const;

/** The look `Input`, `Textarea` and `Select` share, from Input's tokens (`--input-*`). */
export function controlClassName(className?: string): string {
    return cx(
        'block w-full min-w-0 rounded-(--input-radius) border border-(--input-border) bg-(--input-bg) px-3 text-sm text-(--input-text)',
        // Safari on a phone zooms the page into any field under 16px when it gets focus.
        'pointer-coarse:text-base',
        'shadow-(--input-shadow) placeholder:text-(--input-placeholder)',
        'motion-safe:transition-[color,background-color,border-color] motion-safe:duration-(--motion-state) motion-safe:ease-standard',
        'hover:border-(--input-border-hover)',
        // The focus ring hugs the field: a teal border and a soft halo. The outline goes transparent, not away, so
        // forced-colours mode still draws it.
        'focus-visible:border-(--input-border-focus) focus-visible:shadow-[0_0_0_3px_var(--input-ring)] focus-visible:outline-transparent',
        'aria-invalid:border-(--input-border-invalid)',
        'disabled:cursor-not-allowed disabled:border-(--input-border-disabled) disabled:bg-(--input-bg-disabled) disabled:text-(--input-text-disabled)',
        className,
    );
}

/** `aria-invalid` from `invalid`, unless the caller (e.g. `Field`) already set it. */
export function invalidAttribute(invalid: boolean | undefined, explicit: unknown): true | undefined {
    if (explicit !== undefined) return explicit === true || explicit === 'true' ? true : undefined;
    return invalid === true ? true : undefined;
}

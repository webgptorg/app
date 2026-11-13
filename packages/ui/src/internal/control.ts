import { cx } from './cx';

/** The look `Input`, `Textarea` and `Select` share, from Input's tokens (`--input-*`). */
export function controlClassName(className?: string): string {
    return cx(
        'block w-full min-w-0 rounded-(--input-radius) border border-(--input-border) bg-(--input-bg) px-3 text-sm text-(--input-text)',
        'shadow-(--input-shadow) placeholder:text-(--input-placeholder)',
        'motion-safe:transition-[color,background-color,border-color] motion-safe:duration-(--motion-state) motion-safe:ease-standard',
        'hover:border-(--input-border-hover) focus-visible:border-(--input-border-focus)',
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

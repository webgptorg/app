import { cx } from '../../app/cx';
import { m } from '../../paraglide/messages';

export type BookView = 'book' | 'test';

export interface BookViewSwitchProps {
    readonly view: BookView;
    readonly onChange: (view: BookView) => void;
    readonly className?: string;
}

const VIEWS: readonly { readonly id: BookView; readonly label: () => string }[] = [
    { id: 'book', label: m.book_view_book },
    { id: 'test', label: m.book_view_test },
];

/**
 * Book or test chat, for screens too narrow to show both. Both stay mounted and only one is displayed, so switching
 * keeps the editor's undo history and the test conversation; on wide screens the switch is hidden and both show.
 */
export function BookViewSwitch({ view, onChange, className }: BookViewSwitchProps) {
    return (
        <div
            role="group"
            aria-label={m.book_view_label()}
            className={cx('inline-flex w-fit gap-0.5 rounded-control bg-sunken p-0.5', className)}
        >
            {VIEWS.map(({ id, label }) => (
                <button
                    key={id}
                    type="button"
                    aria-pressed={view === id}
                    onClick={() => {
                        onChange(id);
                    }}
                    className={cx(
                        'min-h-9 rounded-control border px-4 text-sm motion-safe:transition-colors motion-safe:duration-(--motion-state) focus-visible:outline-2 focus-visible:outline-focus',
                        // The border carries the selected state at 3:1 in both themes; colour alone was too faint.
                        view === id
                            ? 'border-border bg-raised font-semibold text-text shadow-subtle'
                            : 'border-transparent font-medium text-text-muted hover:text-text',
                    )}
                >
                    {label()}
                </button>
            ))}
        </div>
    );
}

import { ChevronLeft, ChevronRight } from 'lucide-react';

import { useUiMessages } from '../../i18n/ui-provider';
import { cx } from '../../internal/cx';
import { Button } from '../button/button';

export interface PaginationProps {
    readonly hasPrevious: boolean;
    readonly hasNext: boolean;
    readonly onPrevious: () => void;
    readonly onNext: () => void;
    /** Shown when the API reports it; cursor paging often cannot. */
    readonly total?: number;
    /** E.g. while the next page loads. */
    readonly disabled?: boolean;
    readonly className?: string;
}

/** Previous and next for cursor-paged lists; page numbers do not exist with cursors. */
export function Pagination({
    hasPrevious,
    hasNext,
    onPrevious,
    onNext,
    total,
    disabled = false,
    className,
}: PaginationProps) {
    const messages = useUiMessages();
    return (
        <nav
            aria-label={messages.pagination()}
            className={cx('flex flex-wrap items-center justify-between gap-3', className)}
        >
            <p className="text-sm text-(--pagination-total)">
                {total === undefined ? null : messages.totalItems({ count: total })}
            </p>
            <div className="flex gap-2">
                <Button size="sm" disabled={disabled || !hasPrevious} onClick={onPrevious}>
                    <ChevronLeft aria-hidden="true" className="size-4 rtl:rotate-180" />
                    {messages.previousPage()}
                </Button>
                <Button size="sm" disabled={disabled || !hasNext} onClick={onNext}>
                    {messages.nextPage()}
                    <ChevronRight aria-hidden="true" className="size-4 rtl:rotate-180" />
                </Button>
            </div>
        </nav>
    );
}

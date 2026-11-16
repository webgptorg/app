import { Skeleton } from '@ptbk/ui';

/** While a card's code loads on the first hover: the card's shape, so it does not jump. */
export function CardFallback() {
    return (
        <span aria-busy="true" className="flex w-80 max-w-full flex-col gap-2 py-1">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-24" />
        </span>
    );
}

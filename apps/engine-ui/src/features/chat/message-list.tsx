import type { MemberId } from '@ptbk/engine-api';
import { Button, Skeleton } from '@ptbk/ui';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { m } from '../../paraglide/messages';
import { useCurrentMember } from '../session/use-current-member';
import { MessageRow } from './message-row';
import type { ThreadView } from './message-views';

/** A guess for rows not measured yet; measuring corrects it once a row is mounted. */
export const ESTIMATED_ROW_PX = 120;
/** How close to an edge counts as "at" it: at the bottom new text follows, at the top older messages load. */
export const NEAR_EDGE_PX = 160;

export interface MessageListProps {
    readonly label: string;
    readonly views: readonly ThreadView[];
    /** Above the panel's threshold only the visible window is mounted; find-in-page then misses the rest. */
    readonly virtual: boolean;
    readonly hasOlder: boolean;
    readonly loadingOlder: boolean;
    readonly onLoadOlder: () => void;
    readonly onRetry: () => void;
    /** Answers a question with one of its offered choices; absent for members who may not write. */
    readonly onAnswer?: (messageId: string, choice: string) => void;
    /** Questions actually scrolled into view, so the engine can mark them seen for everyone. */
    readonly onSeen?: (messageIds: readonly string[]) => void;
    /** After "Jump to latest", e.g. to put focus back into the composer. */
    readonly onJumpedToLatest?: () => void;
}

// An agent's steps and the reply after them are one turn, under one author header.
const authorOf = (view: ThreadView | undefined): string | null =>
    view?.kind === 'message' || view?.kind === 'steps'
        ? `${view.author.kind}:${view.author.key}:${view.createdBy ?? ''}`
        : null;

/** A message by someone other than the one before it (or after an event) starts a new turn, which names its author. */
function turnOf(view: ThreadView, before: ThreadView | undefined, me: MemberId) {
    const startsTurn = authorOf(before) !== authorOf(view);
    // The member's own bubble already marks the words as theirs.
    const own = view.kind === 'message' && view.author.kind === 'user' && view.createdBy === me;
    return { startsTurn, showAuthor: startsTurn && !own };
}

/**
 * The conversation, oldest first, in its own scroll area: it follows new text while the reader is at the bottom,
 * keeps the reader's place when older pages arrive above, and offers "Jump to latest" when scrolled up.
 */
export function MessageList(props: MessageListProps) {
    const { views, virtual, onSeen } = props;
    const me = useCurrentMember().memberId;
    const scrollRef = useRef<HTMLDivElement>(null);
    const atBottomRef = useRef(true);
    const [atBottom, setAtBottom] = useState(true);
    // The React Compiler cannot memoise TanStack Virtual's mutable instance; this app does not compile with it.
    // eslint-disable-next-line react-hooks/incompatible-library
    const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>({
        count: virtual ? views.length : 0,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => ESTIMATED_ROW_PX,
        getItemKey: (index) => views[index]?.id ?? index,
        overscan: 6,
        // Without layout (a hidden tab, jsdom) an element measures 0; the estimate is the better answer then.
        measureElement: (element) => element.getBoundingClientRect().height || ESTIMATED_ROW_PX,
    });

    const contentHeight = (element: HTMLElement): number =>
        virtual ? virtualizer.getTotalSize() : element.scrollHeight;

    const scrollToEnd = () => {
        const element = scrollRef.current;
        if (element === null) return;
        if (virtual && views.length > 0) virtualizer.scrollToIndex(views.length - 1, { align: 'end' });
        element.scrollTop = contentHeight(element);
    };

    const firstId = views[0]?.id;
    const lastView = views.at(-1);
    const sending = lastView?.kind === 'message' && lastView.state === 'pending';
    const previous = useRef({ firstId, count: views.length, height: 0, sending });
    useLayoutEffect(() => {
        const element = scrollRef.current;
        if (element === null) return;
        const before = previous.current;
        const height = contentHeight(element);
        if (sending && !before.sending) {
            // The member's own message: they want to see it and its reply, wherever they had scrolled to. The scroll
            // event this causes clears "Jump to latest".
            atBottomRef.current = true;
        }
        if (before.firstId !== undefined && firstId !== before.firstId && views.length > before.count) {
            // Older messages arrived above: move down by what they added, so the same message stays in view.
            element.scrollTop += height - before.height;
        } else if (atBottomRef.current) {
            scrollToEnd();
        }
        previous.current = { firstId, count: views.length, height: contentHeight(element), sending };
    });

    useEffect(() => {
        // Seen means displayed: only a question that actually enters the visible area counts, never a preload.
        const root = scrollRef.current;
        if (root === null || onSeen === undefined || typeof IntersectionObserver === 'undefined') return;
        const observer = new IntersectionObserver(
            (records) => {
                const seen = records.flatMap((record) =>
                    record.isIntersecting ? [(record.target as HTMLElement).dataset['messageId'] ?? ''] : [],
                );
                if (seen.length > 0) onSeen(seen.filter((id) => id !== ''));
            },
            { root, threshold: 0.6 },
        );
        for (const element of root.querySelectorAll('[data-unseen-question]')) observer.observe(element);
        return () => {
            observer.disconnect();
        };
    });

    const onScroll = () => {
        const element = scrollRef.current;
        if (element === null) return;
        const bottom = contentHeight(element) - element.scrollTop - element.clientHeight <= NEAR_EDGE_PX;
        atBottomRef.current = bottom;
        setAtBottom(bottom);
        if (element.scrollTop <= NEAR_EDGE_PX && props.hasOlder && !props.loadingOlder) props.onLoadOlder();
    };

    const items = virtual ? virtualizer.getVirtualItems() : [];
    const first = items[0];
    const last = items.at(-1);
    const rows = virtual
        ? items.flatMap((item) => {
              const view = views[item.index];
              return view === undefined
                  ? []
                  : [
                        <MessageRow
                            key={view.id}
                            ref={virtualizer.measureElement}
                            index={item.index}
                            view={view}
                            {...turnOf(view, views[item.index - 1], me)}
                            onRetry={props.onRetry}
                            onAnswer={props.onAnswer}
                        />,
                    ];
          })
        : views.map((view, position) => (
              <MessageRow
                  key={view.id}
                  view={view}
                  {...turnOf(view, views[position - 1], me)}
                  onRetry={props.onRetry}
                  onAnswer={props.onAnswer}
              />
          ));

    return (
        <div className="relative min-h-0 flex-1">
            <div
                ref={scrollRef}
                role="region"
                aria-label={props.label}
                // A scrollable region must be reachable by keyboard (axe: scrollable-region-focusable).
                // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                tabIndex={0}
                onScroll={onScroll}
                // The last lines fade out under the floating composer, and the padding lets them scroll clear of it.
                className="scroll-quiet h-full overflow-y-auto overscroll-contain px-1 pb-12 [mask-image:linear-gradient(to_top,transparent,#000_3rem)] focus-visible:outline-2 focus-visible:outline-focus"
            >
                <div className="mx-auto w-full max-w-3xl">
                    {props.hasOlder ? (
                        <div className="flex h-12 items-center justify-center">
                            {props.loadingOlder ? (
                                <div aria-busy="true" className="w-full">
                                    <span className="sr-only" role="status">
                                        {m.loading()}
                                    </span>
                                    <Skeleton shape="block" className="h-8 w-2/3" />
                                </div>
                            ) : (
                                <Button size="sm" variant="ghost" onClick={props.onLoadOlder}>
                                    {m.ui_show_more()}
                                </Button>
                            )}
                        </div>
                    ) : null}
                    {virtual ? <div aria-hidden="true" style={{ height: first?.start ?? 0 }} /> : null}
                    {rows}
                    {virtual ? (
                        <div
                            aria-hidden="true"
                            style={{ height: last === undefined ? 0 : virtualizer.getTotalSize() - last.end }}
                        />
                    ) : null}
                </div>
            </div>
            {atBottom ? null : (
                <button
                    type="button"
                    className="absolute bottom-10 left-1/2 inline-flex h-8 -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-pill bg-raised px-3 text-xs font-medium text-text-muted shadow-raised ring-1 ring-divider hover:text-text motion-safe:animate-rise-in"
                    onClick={() => {
                        atBottomRef.current = true;
                        setAtBottom(true);
                        scrollToEnd();
                        props.onJumpedToLatest?.();
                    }}
                >
                    <ArrowDown aria-hidden className="size-3.5" />
                    {m.chat_jump_latest()}
                </button>
            )}
        </div>
    );
}

import type { AgentProfile, MemberId } from '@ptbk/engine-api';
import { Button, Skeleton } from '@ptbk/ui';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';

import { m } from '../../paraglide/messages';
import { useCurrentMember } from '../session/use-current-member';
import { MessageRow } from './message-row';
import type { MessageView } from './message-views';

/** A guess for rows not measured yet; measuring corrects it once a row is mounted. */
export const ESTIMATED_ROW_PX = 120;
/** How close to an edge counts as "at" it: at the bottom new text follows, at the top older messages load. */
export const NEAR_EDGE_PX = 160;

export interface MessageListProps {
    readonly label: string;
    readonly views: readonly MessageView[];
    readonly agentName: string;
    /** For the avatar beside the agent's replies; without it the avatar is the name's initial. */
    readonly agentProfile?: Pick<AgentProfile, 'avatarUrl' | 'color'>;
    /** Above the panel's threshold only the visible window is mounted; find-in-page then misses the rest. */
    readonly virtual: boolean;
    readonly hasOlder: boolean;
    readonly loadingOlder: boolean;
    readonly onLoadOlder: () => void;
    readonly onRetry: () => void;
    /** After "Jump to latest", e.g. to put focus back into the composer. */
    readonly onJumpedToLatest?: () => void;
}

const NO_PROFILE = { avatarUrl: null, color: null } as const;

/** A message by someone other than the one before it starts a new turn, which names its author. */
function turnOf(view: MessageView, before: MessageView | undefined, me: MemberId) {
    const startsTurn = before === undefined || before.role !== view.role || before.createdBy !== view.createdBy;
    // The member's own bubble already marks the words as theirs.
    const own = view.role === 'user' && view.createdBy === me;
    return { startsTurn, showAuthor: startsTurn && !own };
}

/**
 * The conversation, oldest first, in its own scroll area: it follows new text while the reader is at the bottom,
 * keeps the reader's place when older pages arrive above, and offers "Jump to latest" when scrolled up.
 */
export function MessageList(props: MessageListProps) {
    const { views, virtual, agentProfile = NO_PROFILE } = props;
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
    const sending = lastView?.state === 'pending';
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
                            agentName={props.agentName}
                            agentProfile={agentProfile}
                            {...turnOf(view, views[item.index - 1], me)}
                            onRetry={props.onRetry}
                        />,
                    ];
          })
        : views.map((view, position) => (
              <MessageRow
                  key={view.id}
                  view={view}
                  agentName={props.agentName}
                  agentProfile={agentProfile}
                  {...turnOf(view, views[position - 1], me)}
                  onRetry={props.onRetry}
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
                className="h-full overflow-y-auto overscroll-contain px-1 pb-4 focus-visible:outline-2 focus-visible:outline-focus"
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
                <Button
                    size="sm"
                    className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full! shadow-raised"
                    onClick={() => {
                        atBottomRef.current = true;
                        setAtBottom(true);
                        scrollToEnd();
                        props.onJumpedToLatest?.();
                    }}
                >
                    <ArrowDown aria-hidden className="size-4" />
                    {m.chat_jump_latest()}
                </Button>
            )}
        </div>
    );
}

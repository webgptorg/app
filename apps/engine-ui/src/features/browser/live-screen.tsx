import { Spinner } from '@ptbk/ui';
import { EyeOff, MonitorX } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';

import { useBrowser } from '../../app/browser-context';
import { cx } from '../../app/cx';
import { m } from '../../paraglide/messages';
import { blockedLabel, endReasonLabel } from './browser-labels';
import { createCanvasDrawer } from './canvas-drawer';
import { createClickCounter, heldButton, liveKey, pressedButton, toTabPoint, wheelDelta } from './live-input';
import type { TabViewport } from './live-input';
import type { LiveSession, LiveView } from './live-session';

/** Until the engine reports the tab's viewport: the fake and most laptops are 16:10. */
const DEFAULT_VIEWPORT: TabViewport = { width: 1280, height: 800 };

export interface LiveScreenProps {
    readonly session: LiveSession;
    readonly view: LiveView;
    readonly label: string;
    readonly hintId: string;
    /** Under the end message, e.g. "Watch again". */
    readonly endAction?: ReactNode;
}

function canvasSize(canvas: HTMLCanvasElement) {
    const box = canvas.getBoundingClientRect();
    return { width: box.width, height: box.height };
}

/** Frames stream to this page only while it shows the tab: the canvas attaches on mount and on a visible page. */
function useAttachedCanvas(session: LiveSession, canvas: RefObject<HTMLCanvasElement | null>) {
    const { frameDrawer } = useBrowser();
    useEffect(() => {
        const element = canvas.current;
        if (element === null) return;
        const detach = session.attach((frameDrawer ?? createCanvasDrawer)(element), canvasSize(element));
        const resize =
            typeof ResizeObserver === 'undefined'
                ? null
                : new ResizeObserver(() => {
                      session.resize(canvasSize(element));
                  });
        resize?.observe(element);
        const visibility = () => {
            session.setPageVisible(document.visibilityState !== 'hidden');
        };
        document.addEventListener('visibilitychange', visibility);
        return () => {
            detach();
            resize?.disconnect();
            document.removeEventListener('visibilitychange', visibility);
        };
    }, [session, canvas, frameDrawer]);
}

/**
 * While the member controls the tab: pointer, wheel and the closed key set, in tab coordinates, and nothing else (no
 * clipboard, no files, no shortcut with Ctrl, Cmd or Alt). Moves are coalesced to one per animation frame. Keys pass
 * straight to the channel; nothing of what is typed is kept here.
 */
function useForwardedInput(
    session: LiveSession,
    canvas: RefObject<HTMLCanvasElement | null>,
    { width, height }: TabViewport,
    active: boolean,
) {
    useEffect(() => {
        const element = canvas.current;
        if (!active || element === null) return;
        const viewport = { width, height };
        const point = (event: { clientX: number; clientY: number }) =>
            toTabPoint(event.clientX, event.clientY, element.getBoundingClientRect(), viewport);
        const clicks = createClickCounter(() => performance.now());
        let pressCount = 1;
        let move: { x: number; y: number; button: ReturnType<typeof heldButton> } | null = null;
        let frame: number | null = null;
        const flushMove = () => {
            frame = null;
            if (move !== null) session.input({ kind: 'pointer', action: 'move', clicks: 0, ...move }, false);
            move = null;
        };
        const press = (action: 'down' | 'up') => (event: PointerEvent) => {
            const button = pressedButton(event.button);
            const at = point(event);
            if (button === null || at === null) return;
            event.preventDefault();
            if (action === 'down') {
                element.focus();
                element.setPointerCapture(event.pointerId);
                pressCount = clicks(event.clientX, event.clientY);
            }
            session.input({ kind: 'pointer', action, button, clicks: pressCount, ...at }, true);
        };
        const down = press('down');
        const up = press('up');
        const moved = (event: PointerEvent) => {
            const at = point(event);
            if (at === null) return;
            move = { ...at, button: heldButton(event.buttons) };
            frame ??= requestAnimationFrame(flushMove);
        };
        const wheel = (event: WheelEvent) => {
            const at = point(event);
            if (at === null) return;
            event.preventDefault();
            session.input(
                {
                    kind: 'wheel',
                    ...at,
                    deltaX: wheelDelta(event.deltaX, event.deltaMode),
                    deltaY: wheelDelta(event.deltaY, event.deltaMode),
                },
                false,
            );
        };
        const key = (action: 'down' | 'up') => (event: KeyboardEvent) => {
            // The way out for keyboard users: everything else, Tab included, goes to the site.
            if (action === 'down' && event.key === 'Escape' && event.shiftKey) {
                element.blur();
                return;
            }
            const live = liveKey(event);
            if (live === null) return;
            event.preventDefault();
            session.input({ kind: 'key', action, ...live }, true);
        };
        const keyDown = key('down');
        const keyUp = key('up');
        const noMenu = (event: Event) => {
            event.preventDefault();
        };
        element.addEventListener('pointerdown', down);
        element.addEventListener('pointerup', up);
        element.addEventListener('pointermove', moved);
        // Not passive: the page must not scroll while the wheel scrolls the tab.
        element.addEventListener('wheel', wheel, { passive: false });
        element.addEventListener('keydown', keyDown);
        element.addEventListener('keyup', keyUp);
        element.addEventListener('contextmenu', noMenu);
        return () => {
            if (frame !== null) cancelAnimationFrame(frame);
            element.removeEventListener('pointerdown', down);
            element.removeEventListener('pointerup', up);
            element.removeEventListener('pointermove', moved);
            element.removeEventListener('wheel', wheel);
            element.removeEventListener('keydown', keyDown);
            element.removeEventListener('keyup', keyUp);
            element.removeEventListener('contextmenu', noMenu);
        };
    }, [session, canvas, width, height, active]);
}

function Overlay({ icon, children }: { readonly icon: ReactNode; readonly children: ReactNode }) {
    return (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-sm text-text-muted">
            <span className="flex [&>svg]:size-6">{icon}</span>
            {children}
        </div>
    );
}

/** The tab as a picture scaled to the page, with the state it is in over it when there is no frame to show. */
export function LiveScreen({ session, view, label, hintId, endAction }: LiveScreenProps) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const viewport = view.viewport ?? DEFAULT_VIEWPORT;
    const controlling =
        view.mode === 'controlling' && view.blocked === null && view.connection === 'open' && view.endReason === null;
    useAttachedCanvas(session, canvas);
    useForwardedInput(session, canvas, viewport, controlling);

    let overlay: ReactNode = null;
    if (view.endReason !== null) {
        overlay = (
            <Overlay icon={<MonitorX aria-hidden />}>
                <p className="max-w-sm text-text">{endReasonLabel(view.endReason)}</p>
                {endAction}
            </Overlay>
        );
    } else if (view.blocked !== null) {
        overlay = (
            <Overlay icon={<EyeOff aria-hidden />}>
                <p className="max-w-sm [overflow-wrap:anywhere] text-text">{blockedLabel(view.blocked)}</p>
            </Overlay>
        );
    } else if (!view.hasFrame) {
        overlay = (
            <Overlay icon={<Spinner />}>
                <p>{m.browser_connecting_body()}</p>
            </Overlay>
        );
    }

    return (
        <div className="relative overflow-hidden rounded-surface border border-hairline bg-sunken">
            <canvas
                ref={canvas}
                width={viewport.width}
                height={viewport.height}
                role={controlling ? 'application' : 'img'}
                aria-label={label}
                aria-describedby={hintId}
                tabIndex={controlling ? 0 : -1}
                className={cx(
                    'block h-auto w-full focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
                    controlling && 'cursor-default touch-none',
                    overlay !== null && 'invisible',
                )}
            />
            {overlay}
        </div>
    );
}

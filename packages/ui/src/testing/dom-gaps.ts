/**
 * jsdom lacks `matchMedia`, `<dialog>`'s modal methods and the Popover API. These stand-ins model only what the
 * components rely on (open state, events, focus); real browser behaviour (top layer, inertness) is checked by
 * engine-ui's `test:csp` against the gallery.
 */

const mediaFeatures = new Map<string, boolean>();
const mediaListeners = new Map<string, Set<() => void>>();

/** Sets what `matchMedia(query).matches` answers, and notifies listeners, e.g. `setMedia('(prefers-reduced-motion: reduce)', true)`. */
export function setMedia(query: string, matches: boolean): void {
    mediaFeatures.set(query, matches);
    for (const listener of mediaListeners.get(query) ?? []) listener();
}

export function resetMedia(): void {
    mediaFeatures.clear();
}

export const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
export const PREFERS_DARK = '(prefers-color-scheme: dark)';
/** The width at which components switch to their narrow layout. */
export const NARROW = '(max-width: 767.98px)';

function fakeMatchMedia(query: string): MediaQueryList {
    const listeners = mediaListeners.get(query) ?? new Set<() => void>();
    mediaListeners.set(query, listeners);
    return {
        media: query,
        get matches() {
            return mediaFeatures.get(query) ?? false;
        },
        onchange: null,
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
        addListener: (listener: () => void) => listeners.add(listener),
        removeListener: (listener: () => void) => listeners.delete(listener),
        dispatchEvent: () => true,
    } as unknown as MediaQueryList;
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function installDialog(): void {
    const proto = HTMLDialogElement.prototype as HTMLDialogElement & { __ptbkFake?: true };
    if (typeof proto.showModal === 'function' && proto.__ptbkFake !== true) return;
    proto.__ptbkFake = true;
    proto.show = function show(this: HTMLDialogElement) {
        this.setAttribute('open', '');
    };
    proto.showModal = function showModal(this: HTMLDialogElement) {
        if (!this.isConnected) throw new DOMException('not connected', 'InvalidStateError');
        this.setAttribute('open', '');
        this.dataset['fakeModal'] = 'true';
        const autofocus = this.querySelector<HTMLElement>('[autofocus]') ?? this.querySelector<HTMLElement>(FOCUSABLE);
        autofocus?.focus();
    };
    proto.close = function close(this: HTMLDialogElement, returnValue?: string) {
        if (!this.hasAttribute('open')) return;
        this.removeAttribute('open');
        delete this.dataset['fakeModal'];
        if (returnValue !== undefined) this.returnValue = returnValue;
        this.dispatchEvent(new Event('close'));
    };
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        const dialogs = [...document.querySelectorAll<HTMLDialogElement>('dialog[data-fake-modal]')];
        const top = dialogs.at(-1);
        if (top === undefined) return;
        const cancel = new Event('cancel', { cancelable: true });
        if (top.dispatchEvent(cancel)) top.close();
    });
}

function installPopover(): void {
    const proto = HTMLElement.prototype as HTMLElement & { __ptbkFake?: true };
    if (typeof proto.showPopover === 'function' && proto.__ptbkFake !== true) return;
    proto.__ptbkFake = true;
    const toggle = (element: HTMLElement, open: boolean) => {
        const wasOpen = element.dataset['fakePopoverOpen'] === 'true';
        if (wasOpen === open) return;
        if (open) element.dataset['fakePopoverOpen'] = 'true';
        else delete element.dataset['fakePopoverOpen'];
        const event = new Event('toggle') as Event & { oldState?: string; newState?: string };
        Object.assign(event, { oldState: wasOpen ? 'open' : 'closed', newState: open ? 'open' : 'closed' });
        element.dispatchEvent(event);
    };
    proto.showPopover = function showPopover(this: HTMLElement) {
        toggle(this, true);
    };
    proto.hidePopover = function hidePopover(this: HTMLElement) {
        toggle(this, false);
    };
    proto.togglePopover = function togglePopover(this: HTMLElement, force?: boolean | { force?: boolean }) {
        const forced = typeof force === 'object' ? force.force : force;
        const next = forced ?? this.dataset['fakePopoverOpen'] !== 'true';
        toggle(this, next);
        return next;
    };
}

class FakeResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
}

export function installDomGaps(): void {
    window.matchMedia = fakeMatchMedia;
    installDialog();
    installPopover();
    window.scrollTo = () => undefined;
    Element.prototype.scrollIntoView = () => undefined;
    if (!('ResizeObserver' in globalThis)) {
        globalThis.ResizeObserver = FakeResizeObserver;
    }
}

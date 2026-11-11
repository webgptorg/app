import { describe, expect, it } from 'vitest';

import { mayOpenBrowser, setupLinkDelivery } from './setup-link-delivery';

const MAC = { platform: 'darwin', env: {} };
const LINUX_DESKTOP = { platform: 'linux', env: { DISPLAY: ':0' } };

describe('mayOpenBrowser', () => {
    it('opens on a local macOS session', () => {
        expect(mayOpenBrowser(MAC, false)).toBe(true);
    });

    it('opens on Linux only with an X11 or Wayland display', () => {
        expect(mayOpenBrowser(LINUX_DESKTOP, false)).toBe(true);
        expect(mayOpenBrowser({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } }, false)).toBe(true);
        expect(mayOpenBrowser({ platform: 'linux', env: {} }, false)).toBe(false);
        expect(mayOpenBrowser({ platform: 'linux', env: { DISPLAY: '' } }, false)).toBe(false);
    });

    it('never opens over SSH, where the browser would be on the remote screen', () => {
        for (const ssh of [{ SSH_CONNECTION: '10.0.0.2 51234 10.0.0.1 22' }, { SSH_TTY: '/dev/ttys004' }]) {
            expect(mayOpenBrowser({ platform: 'darwin', env: ssh }, false)).toBe(false);
            expect(mayOpenBrowser({ platform: 'linux', env: { DISPLAY: ':10', ...ssh } }, false)).toBe(false);
        }
    });

    it('never opens on other platforms', () => {
        expect(mayOpenBrowser({ platform: 'win32', env: {} }, false)).toBe(false);
        expect(mayOpenBrowser({ platform: 'freebsd', env: { DISPLAY: ':0' } }, false)).toBe(false);
    });

    it('is switched off by --no-open and by PTBK_NO_OPEN', () => {
        expect(mayOpenBrowser(MAC, true)).toBe(false);
        expect(mayOpenBrowser(LINUX_DESKTOP, true)).toBe(false);
        expect(mayOpenBrowser({ platform: 'darwin', env: { PTBK_NO_OPEN: '1' } }, false)).toBe(false);
        expect(mayOpenBrowser({ platform: 'linux', env: { DISPLAY: ':0', PTBK_NO_OPEN: '1' } }, false)).toBe(false);
        expect(mayOpenBrowser({ platform: 'darwin', env: { PTBK_NO_OPEN: '0' } }, false)).toBe(true);
        expect(mayOpenBrowser({ platform: 'darwin', env: { PTBK_NO_OPEN: '' } }, false)).toBe(true);
    });
});

describe('setupLinkDelivery', () => {
    it('prints, and opens where allowed, on a terminal while there is no owner', () => {
        expect(setupLinkDelivery({ terminal: true, ownerSetUp: false, mayOpen: true })).toBe('print-and-open');
        expect(setupLinkDelivery({ terminal: true, ownerSetUp: false, mayOpen: false })).toBe('print');
    });

    it('never shows the link outside a terminal, where it would end up in a log', () => {
        expect(setupLinkDelivery({ terminal: false, ownerSetUp: false, mayOpen: true })).toBe('none');
        expect(setupLinkDelivery({ terminal: false, ownerSetUp: false, mayOpen: false })).toBe('none');
    });

    it('shows nothing once the engine has an owner', () => {
        expect(setupLinkDelivery({ terminal: true, ownerSetUp: true, mayOpen: true })).toBe('none');
    });
});

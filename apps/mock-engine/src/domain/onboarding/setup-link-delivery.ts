/**
 * Opens a URL in the desktop's default browser; resolves false when that did not work. The URL carries the setup
 * secret, so an implementation never logs it or hands it to a shell.
 */
export type BrowserOpener = (url: string) => Promise<boolean>;

/** The session the command runs in, as far as opening a browser is concerned. */
export interface BrowserSession {
    /** `process.platform`. */
    readonly platform: string;
    readonly env: Readonly<Record<string, string | undefined>>;
}

function isSet(value: string | undefined): boolean {
    return value !== undefined && value !== '';
}

/**
 * Whether a browser may be opened: only in a local desktop session, where the person at the terminal is the one who
 * sees the browser. Over SSH a browser would open on the remote host's screen (or fail), and a Linux host without a
 * display has no browser to open. `--no-open` and `PTBK_NO_OPEN=1` switch it off for anything else, such as a shared
 * screen.
 */
export function mayOpenBrowser(session: BrowserSession, noOpenFlag: boolean): boolean {
    const { env } = session;
    if (noOpenFlag || (isSet(env['PTBK_NO_OPEN']) && env['PTBK_NO_OPEN'] !== '0')) return false;
    if (isSet(env['SSH_CONNECTION']) || isSet(env['SSH_TTY'])) return false;
    if (session.platform === 'darwin') return true;
    if (session.platform === 'linux') return isSet(env['DISPLAY']) || isSet(env['WAYLAND_DISPLAY']);
    return false;
}

export type SetupLinkDelivery = 'none' | 'print' | 'print-and-open';

/**
 * How a fresh setup link reaches the operator. Only an interactive terminal ever shows it: output that is not a
 * terminal tends to end up in logs, and whoever opens the link first becomes the owner. An engine with an owner gets
 * no link at all.
 */
export function setupLinkDelivery(input: {
    readonly terminal: boolean;
    readonly ownerSetUp: boolean;
    readonly mayOpen: boolean;
}): SetupLinkDelivery {
    if (!input.terminal || input.ownerSetUp) return 'none';
    return input.mayOpen ? 'print-and-open' : 'print';
}

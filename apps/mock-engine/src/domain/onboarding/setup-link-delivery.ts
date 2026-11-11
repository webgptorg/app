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

const HYPERLINK_PROGRAMS: ReadonlySet<string> = new Set(['iTerm.app', 'WezTerm', 'vscode', 'ghostty', 'Hyper']);
const HYPERLINK_TERMS: ReadonlySet<string> = new Set([
    'xterm-kitty',
    'xterm-ghostty',
    'alacritty',
    'foot',
    'foot-extra',
]);
const VTE_WITH_HYPERLINKS = 5000;

/**
 * Whether the terminal renders OSC 8 hyperlinks, so the printed link is clickable. Only terminals known to support
 * them: others may print the escape sequence as text, and a multiplexer (tmux, screen) may drop or mangle it.
 * `FORCE_HYPERLINK=1` or `=0` overrides the guess.
 */
export function terminalHyperlinks(env: BrowserSession['env']): boolean {
    const forced = env['FORCE_HYPERLINK'];
    if (isSet(forced)) return forced !== '0';
    const term = env['TERM'] ?? '';
    if (term === 'dumb' || isSet(env['CI'])) return false;
    if (isSet(env['TMUX']) || term.startsWith('screen') || term.startsWith('tmux')) return false;
    if (HYPERLINK_PROGRAMS.has(env['TERM_PROGRAM'] ?? '') || HYPERLINK_TERMS.has(term)) return true;
    if (isSet(env['WT_SESSION'])) return true;
    return Number(env['VTE_VERSION'] ?? '0') >= VTE_WITH_HYPERLINKS;
}

function hasControlCharacter(text: string): boolean {
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
    }
    return false;
}

/**
 * `url` as an OSC 8 hyperlink whose visible text is the URL itself, so copying it still works. A URL with a control
 * character is left plain: it could end the sequence early and smuggle another one in.
 */
export function osc8Hyperlink(url: string): string {
    if (hasControlCharacter(url)) return url;
    return `\u001b]8;;${url}\u001b\\${url}\u001b]8;;\u001b\\`;
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

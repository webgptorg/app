import type { ReadBrowserHelpRequest, ReadBrowserTab } from '@ptbk/engine-api';
import type { StatusTone } from '@ptbk/ui';

import { m } from '../../paraglide/messages';
import { siteName } from '../wallet/wallet-origin';
import type { LiveBlock, LiveEndReason, LiveView } from './live-session';

/** "on shop.example", or "on a hidden page" while the engine withholds the origin. */
export function whereLabel(origin: string | null): string {
    return m.browser_on_site({ site: origin === null ? m.browser_hidden_site() : siteName(origin) });
}

export function endReasonLabel(reason: LiveEndReason): string {
    switch (reason) {
        case 'expired':
            return m.browser_end_expired();
        case 'idle':
            return m.browser_end_idle();
        case 'not-attached':
            return m.browser_end_not_attached();
        case 'revoked':
            return m.browser_end_revoked();
        case 'tab-closed':
            return m.browser_end_tab_closed();
        case 'engine-stopped':
            return m.browser_end_engine_stopped();
        case 'protocol-error':
            return m.browser_end_protocol_error();
        case 'ended':
        case 'unknown':
            return m.browser_end_ended();
    }
}

export function blockedLabel(block: LiveBlock): string {
    switch (block.reason) {
        case 'origin-not-allowed':
            return block.origin === null
                ? m.browser_blocked_unknown()
                : m.browser_blocked_origin({ site: siteName(block.origin) });
        case 'browser-page':
            return m.browser_blocked_browser_page();
        case 'secret-page':
            return m.browser_blocked_secret_page();
        case 'unknown':
            return m.browser_blocked_unknown();
    }
}

export interface ViewState {
    readonly label: string;
    readonly tone: StatusTone;
}

/** One word or two for where the session stands, most specific first; the viewer and the shell say the same. */
export function viewState(view: LiveView): ViewState {
    if (view.endReason !== null) return { label: m.browser_state_ended(), tone: 'neutral' };
    if (view.connection === 'connecting') return { label: m.browser_state_connecting(), tone: 'neutral' };
    if (view.connection === 'reconnecting') return { label: m.browser_state_reconnecting(), tone: 'warning' };
    if (view.blocked !== null) return { label: m.browser_state_blocked(), tone: 'warning' };
    if (view.mode === 'controlling') return { label: m.browser_state_controlling(), tone: 'live' };
    if (view.agent === 'paused') return { label: m.browser_state_someone_controls(), tone: 'warning' };
    if (view.agent === 'waiting') return { label: m.browser_state_agent_waiting(), tone: 'warning' };
    return { label: m.browser_state_watching(), tone: 'live' };
}

/** "Ada needs you to sign in", in the words of the request's reason. */
export function helpTitle(reason: ReadBrowserHelpRequest['reason'], agent: string): string {
    switch (reason) {
        case 'login':
            return m.browser_help_login({ agent });
        case 'captcha':
            return m.browser_help_captcha({ agent });
        case 'confirmation':
            return m.browser_help_confirmation({ agent });
        case 'blocked':
            return m.browser_help_blocked({ agent });
        case 'other':
        case 'unknown':
            return m.browser_help_other({ agent });
    }
}

export function tabState(state: ReadBrowserTab['agentState']): ViewState | null {
    switch (state) {
        case 'working':
            return { label: m.browser_tab_working(), tone: 'live' };
        case 'waiting':
            return { label: m.browser_tab_waiting(), tone: 'warning' };
        case 'paused':
            return { label: m.browser_tab_paused(), tone: 'warning' };
        case 'none':
        case 'unknown':
            return null;
    }
}

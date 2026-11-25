import type { ReadAiTool } from '@ptbk/engine-api';
import type { StatusTone } from '@ptbk/ui';

import { m } from '../../paraglide/messages';

type Status = ReadAiTool['status'];
type ProblemCode = NonNullable<ReadAiTool['problem']>['code'];

export function statusTone(status: Status): StatusTone {
    switch (status) {
        case 'signed-in':
            return 'success';
        case 'needs-sign-in':
            return 'danger';
        case 'error':
            return 'warning';
        case 'not-installed':
        case 'unknown':
            return 'neutral';
    }
}

export function statusLabel(status: Status): string {
    switch (status) {
        case 'signed-in':
            return m.ai_tools_status_signed_in();
        case 'needs-sign-in':
            return m.ai_tools_status_needs_sign_in();
        case 'error':
            return m.ai_tools_status_error();
        case 'not-installed':
            return m.ai_tools_status_not_installed();
        case 'unknown':
            return m.ai_tools_status_unknown();
    }
}

/** What went wrong in the UI's own words; the engine's message follows as the detail. */
export function problemLabel(code: ProblemCode): string {
    switch (code) {
        case 'sign-in-expired':
            return m.ai_tools_problem_sign_in_expired();
        case 'not-signed-in':
            return m.ai_tools_problem_not_signed_in();
        case 'key-rejected':
            return m.ai_tools_problem_key_rejected();
        case 'quota-exceeded':
            return m.ai_tools_problem_quota_exceeded();
        case 'provider-unavailable':
            return m.ai_tools_problem_provider_unavailable();
        case 'check-failed':
        case 'unknown':
            return m.ai_tools_problem_check_failed();
        case 'not-installed':
            return m.ai_tools_problem_not_installed();
    }
}

/** How the tool signs in now, in words; `null` while it has no credentials. */
export function authLabel(auth: ReadAiTool['auth']): string | null {
    if (auth === null) return null;
    switch (auth.method) {
        case 'account':
            return auth.account === null
                ? m.ai_tools_auth_account()
                : m.ai_tools_auth_account_named({ account: auth.account });
        case 'api-key':
            return m.ai_tools_auth_api_key();
        case 'unknown':
            return null;
    }
}

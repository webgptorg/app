import { isAuditAction } from '@ptbk/engine-api';
import type { AuditAction, AuditEntry, ReadAuditAction } from '@ptbk/engine-api';
import type { StatusTone } from '@ptbk/ui';

import { m } from '../../paraglide/messages';

type TargetKind = NonNullable<AuditEntry['target']>['kind'];
type Outcome = AuditEntry['outcome'];

const ACTION_LABELS: Readonly<Record<AuditAction, () => string>> = {
    'auth.sign-in': m.audit_action_auth_sign_in,
    'auth.sign-out': m.audit_action_auth_sign_out,
    'auth.step-up': m.audit_action_auth_step_up,
    'passkey.register': m.audit_action_passkey_register,
    'passkey.revoke': m.audit_action_passkey_revoke,
    'session.revoke': m.audit_action_session_revoke,
    'session.revoke-others': m.audit_action_session_revoke_others,
    'agent.create': m.audit_action_agent_create,
    'agent.update': m.audit_action_agent_update,
    'agent.delete': m.audit_action_agent_delete,
    'agent.restore': m.audit_action_agent_restore,
    'agent.source.update': m.audit_action_agent_source_update,
    'agent.start': m.audit_action_agent_start,
    'agent.stop': m.audit_action_agent_stop,
    'agent.test-chat.start': m.audit_action_agent_test_chat_start,
    'folder.create': m.audit_action_folder_create,
    'folder.rename': m.audit_action_folder_rename,
    'folder.delete': m.audit_action_folder_delete,
    'chat.create': m.audit_action_chat_create,
    'chat.message.send': m.audit_action_chat_message_send,
    'chat.reply.cancel': m.audit_action_chat_reply_cancel,
    'chat.reply.retry': m.audit_action_chat_reply_retry,
    'member.update': m.audit_action_member_update,
    'member.remove': m.audit_action_member_remove,
    'invite.create': m.audit_action_invite_create,
    'invite.revoke': m.audit_action_invite_revoke,
    'access-request.approve': m.audit_action_access_request_approve,
    'access-request.decline': m.audit_action_access_request_decline,
    'member.revoke': m.audit_action_member_revoke,
    'api-token.create': m.audit_action_api_token_create,
    'api-token.revoke': m.audit_action_api_token_revoke,
    'settings.update': m.audit_action_settings_update,
    'settings.update-policy': m.audit_action_settings_update_policy,
    'settings.dashboard-removals': m.audit_action_settings_dashboard_removals,
    'wallet.record.save': m.audit_action_wallet_record_save,
    'wallet.record.update': m.audit_action_wallet_record_update,
    'wallet.record.delete': m.audit_action_wallet_record_delete,
    'wallet.request.seen': m.audit_action_wallet_request_seen,
    'wallet.request.reject': m.audit_action_wallet_request_reject,
    'file.upload': m.audit_action_file_upload,
    'file.delete': m.audit_action_file_delete,
    'run.cancel': m.audit_action_run_cancel,
    'run.retry': m.audit_action_run_retry,
    'trigger.create': m.audit_action_trigger_create,
    'trigger.update': m.audit_action_trigger_update,
    'trigger.pause': m.audit_action_trigger_pause,
    'trigger.resume': m.audit_action_trigger_resume,
    'trigger.delete': m.audit_action_trigger_delete,
    'integration.create': m.audit_action_integration_create,
    'integration.update': m.audit_action_integration_update,
    'integration.enable': m.audit_action_integration_enable,
    'integration.disable': m.audit_action_integration_disable,
    'integration.delete': m.audit_action_integration_delete,
    'browser.sign-in.open': m.audit_action_browser_sign_in_open,
    'browser.watch': m.audit_action_browser_watch,
    'browser.control.take': m.audit_action_browser_control_take,
    'browser.control.hand-back': m.audit_action_browser_control_hand_back,
    'browser.session.end': m.audit_action_browser_session_end,
    'browser.channel.attach': m.audit_action_browser_channel_attach,
    'browser.help.dismiss': m.audit_action_browser_help_dismiss,
    'ai-tool.sign-in.start': m.audit_action_ai_tool_sign_in_start,
    'ai-tool.sign-in.complete': m.audit_action_ai_tool_sign_in_complete,
    'ai-tool.sign-out': m.audit_action_ai_tool_sign_out,
    'engine.update.install': m.audit_action_engine_update_install,
    'ui.update.install': m.audit_action_ui_update_install,
};

/** A newer engine's action has no label yet and reads as its raw dotted name: a lookup, never an exhaustive switch. */
export function auditActionLabel(action: ReadAuditAction): string {
    return isAuditAction(action) ? ACTION_LABELS[action]() : action;
}

const TARGET_KIND_LABELS: Readonly<Record<TargetKind, () => string>> = {
    agent: m.audit_target_agent,
    folder: m.audit_target_folder,
    chat: m.audit_target_chat,
    message: m.audit_target_message,
    member: m.audit_target_member,
    invite: m.audit_target_invite,
    'access-request': m.audit_target_access_request,
    'api-token': m.audit_target_api_token,
    'wallet-record': m.audit_target_wallet_record,
    'wallet-request': m.audit_target_wallet_request,
    file: m.audit_target_file,
    passkey: m.audit_target_passkey,
    session: m.audit_target_session,
    settings: m.audit_target_settings,
    engine: m.audit_target_engine,
    run: m.audit_target_run,
    trigger: m.audit_target_trigger,
    integration: m.audit_target_integration,
    'browser-session': m.audit_target_browser_session,
    'browser-help-request': m.audit_target_browser_help_request,
    'ai-tool': m.audit_target_ai_tool,
};

export function auditTargetKindLabel(kind: TargetKind): string {
    return TARGET_KIND_LABELS[kind]();
}

export const AUDIT_OUTCOME_LABELS: Readonly<Record<Outcome, () => string>> = {
    success: m.audit_outcome_success,
    denied: m.audit_outcome_denied,
    failed: m.audit_outcome_failed,
};

export const AUDIT_OUTCOME_TONES: Readonly<Record<Outcome, StatusTone>> = {
    success: 'success',
    denied: 'warning',
    failed: 'danger',
};

import { isAuditAction } from '@ptbk/engine-api';
import type { AuditAction, AuditEntry, ReadAuditAction } from '@ptbk/engine-api';
import type { BadgeTone } from '@ptbk/ui';

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
    'folder.create': m.audit_action_folder_create,
    'folder.rename': m.audit_action_folder_rename,
    'folder.delete': m.audit_action_folder_delete,
    'chat.create': m.audit_action_chat_create,
    'chat.message.send': m.audit_action_chat_message_send,
    'chat.reply.cancel': m.audit_action_chat_reply_cancel,
    'member.update': m.audit_action_member_update,
    'member.remove': m.audit_action_member_remove,
    'invite.create': m.audit_action_invite_create,
    'invite.revoke': m.audit_action_invite_revoke,
    'api-token.create': m.audit_action_api_token_create,
    'api-token.revoke': m.audit_action_api_token_revoke,
    'settings.update': m.audit_action_settings_update,
    'settings.update-policy': m.audit_action_settings_update_policy,
    'secret.create': m.audit_action_secret_create,
    'secret.replace': m.audit_action_secret_replace,
    'secret.revoke': m.audit_action_secret_revoke,
    'secret.delete': m.audit_action_secret_delete,
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
    'api-token': m.audit_target_api_token,
    secret: m.audit_target_secret,
    file: m.audit_target_file,
    passkey: m.audit_target_passkey,
    session: m.audit_target_session,
    settings: m.audit_target_settings,
    engine: m.audit_target_engine,
    run: m.audit_target_run,
    trigger: m.audit_target_trigger,
    integration: m.audit_target_integration,
};

export function auditTargetKindLabel(kind: TargetKind): string {
    return TARGET_KIND_LABELS[kind]();
}

export const AUDIT_OUTCOME_LABELS: Readonly<Record<Outcome, () => string>> = {
    success: m.audit_outcome_success,
    denied: m.audit_outcome_denied,
    failed: m.audit_outcome_failed,
};

export const AUDIT_OUTCOME_TONES: Readonly<Record<Outcome, BadgeTone>> = {
    success: 'success',
    denied: 'warning',
    failed: 'danger',
};

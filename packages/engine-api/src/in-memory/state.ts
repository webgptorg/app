import type { Agent, AgentRunStatus, Revision } from '../agents';
import type { ApiToken } from '../api-tokens';
import type { AuditEntry } from '../audit';
import type { Activity } from '../capabilities/activity';
import type { FileMetadata, FileVersion } from '../capabilities/files';
import type { Integration } from '../capabilities/integrations';
import type { RunDetail } from '../capabilities/runs';
import type { Trigger, TriggerFire } from '../capabilities/triggers';
import type { Chat, Message } from '../chats';
import type { OrgId } from '../common';
import type { EngineInfo } from '../engine';
import type { EngineEvent } from '../events';
import type { Folder } from '../folders';
import type { Invite, Member } from '../members';
import type { Passkey } from '../passkeys';
import type { SecretMetadata } from '../secrets';
import type { SecurityOverview } from '../security';
import type { Session } from '../sessions';
import type { Settings } from '../settings';

export interface AgentRecord {
    agent: Agent;
    /** Oldest first. */
    readonly revisions: Revision[];
    runStatus: AgentRunStatus;
}

export interface ReplyRecord {
    readonly chunks: readonly string[];
    readonly outcome: 'completed' | 'failed';
}

export interface FileVersionRecord {
    readonly version: FileVersion;
    readonly content: Blob;
}

export interface FileRecord {
    metadata: FileMetadata;
    /** Oldest first; the last one is the current content. */
    readonly versions: FileVersionRecord[];
}

export interface TriggerRecord {
    trigger: Trigger;
    /** Oldest first. */
    readonly fires: TriggerFire[];
}

export interface EventRecord {
    readonly id: string;
    readonly event: EngineEvent;
}

/** Mutable on purpose: this is the in-memory engine's database, owned by one transport. */
export interface InMemoryState {
    readonly orgId: OrgId;
    engine: EngineInfo;
    settings: Settings;
    security: SecurityOverview;
    readonly members: Map<string, Member>;
    readonly invites: Map<string, Invite>;
    readonly folders: Map<string, Folder>;
    readonly agents: Map<string, AgentRecord>;
    readonly chats: Map<string, Chat>;
    readonly messages: Map<string, Message>;
    readonly replies: Map<string, ReplyRecord>;
    /** Values are never kept: nothing in the contract can read them back, so the fake has no reason to hold them. */
    readonly secrets: Map<string, SecretMetadata>;
    readonly apiTokens: Map<string, ApiToken>;
    readonly passkeys: Map<string, Passkey>;
    readonly sessions: Map<string, Session>;
    readonly files: Map<string, FileRecord>;
    readonly runs: Map<string, RunDetail>;
    readonly triggers: Map<string, TriggerRecord>;
    readonly integrations: Map<string, Integration>;
    /** Oldest first. */
    readonly activity: Activity[];
    readonly audit: AuditEntry[];
    readonly events: EventRecord[];
}

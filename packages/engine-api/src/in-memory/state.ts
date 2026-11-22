import type { Agent, AgentRunStatus, Revision } from '../agents';
import type { ApiToken } from '../api-tokens';
import type { AuditEntry } from '../audit';
import type { Activity } from '../capabilities/activity';
import type { FileMetadata, FilePurpose, FileUploadPolicy, FileVersion } from '../capabilities/files';
import type { Integration } from '../capabilities/integrations';
import type { RunDetail } from '../capabilities/runs';
import type { TaskRecord } from './tasks';
import type { Trigger, TriggerFire } from '../capabilities/triggers';
import type { Message } from '../chats';
import type { AgentId, OrgId, SecretId } from '../common';
import type { EngineInfo } from '../engine';
import type { EngineEvent } from '../events';
import type { Folder } from '../folders';
import type { Invite, Member } from '../members';
import type { AccessRequestRecord } from './access-requests';
import type { OnboardingRecord } from './onboarding';
import type { ChatEvent, ChatRecord, RequestKeyRecord } from './threads';
import type { InMemoryWallet } from './wallet';
import type { InMemoryBrowser } from './live';
import type { Passkey } from '../passkeys';
import type { SecurityOverview } from '../security';
import type { Session } from '../sessions';
import type { Settings } from '../settings';
import type { InMemoryVoice } from './voice';

export interface AgentRecord {
    agent: Agent;
    /** Oldest first. */
    readonly revisions: Revision[];
    runStatus: AgentRunStatus;
}

export interface ReplyRecord {
    readonly chunks: readonly { readonly text: string; readonly delayMs: number }[];
    readonly outcome: 'completed' | 'failed';
    /** Paced replies generate on their own; `generated` counts the chunks produced so far. */
    readonly paced: boolean;
    generated: number;
    /** Stops a paced reply's generation; only the cancel route uses it. */
    readonly stop: AbortController;
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

/**
 * A named tool secret an integration references. The engine API has no route for these; the fake keeps only what
 * resolving a reference needs, and never a value.
 */
export interface IntegrationSecret {
    readonly id: SecretId;
    readonly name: string;
    readonly scope: { readonly kind: 'engine' } | { readonly kind: 'agent'; readonly agentId: AgentId };
    readonly status: 'active' | 'revoked';
}

export interface EventRecord {
    /** The SSE id: `seq` as a string. */
    readonly id: string;
    /** Increases by one per event, across drops from the buffer. */
    readonly seq: number;
    readonly event: EngineEvent;
}

/** Mutable on purpose: this is the in-memory engine's database, owned by one core. */
export interface InMemoryState {
    readonly orgId: OrgId;
    engine: EngineInfo;
    settings: Settings;
    security: SecurityOverview;
    readonly members: Map<string, Member>;
    readonly invites: Map<string, Invite>;
    readonly accessRequests: Map<string, AccessRequestRecord>;
    readonly onboarding: OnboardingRecord;
    readonly voice: InMemoryVoice;
    readonly folders: Map<string, Folder>;
    readonly agents: Map<string, AgentRecord>;
    readonly chats: Map<string, ChatRecord>;
    readonly messages: Map<string, Message>;
    /** Joins, title and status changes; their order lives in each `ChatRecord`. */
    readonly chatEvents: Map<string, ChatEvent>;
    /** `<member> <scope> <requestKey>` to the key's first use; scope is `create` or the thread's ID. */
    readonly chatRequestKeys: Map<string, RequestKeyRecord>;
    readonly replies: Map<string, ReplyRecord>;
    readonly integrationSecrets: Map<string, IntegrationSecret>;
    readonly wallet: InMemoryWallet;
    /** The fake browser's tabs, live sessions and help requests (`browser-tab@1`). */
    readonly browser: InMemoryBrowser;
    readonly apiTokens: Map<string, ApiToken>;
    readonly passkeys: Map<string, Passkey>;
    readonly sessions: Map<string, Session>;
    readonly files: Map<string, FileRecord>;
    readonly uploadPolicies: Readonly<Record<FilePurpose, FileUploadPolicy>>;
    readonly runs: Map<string, RunDetail>;
    readonly tasks: Map<string, TaskRecord>;
    readonly triggers: Map<string, TriggerRecord>;
    readonly integrations: Map<string, Integration>;
    /** Oldest first. */
    readonly activity: Activity[];
    readonly audit: AuditEntry[];
    /** The newest events, oldest first; older ones drop once the buffer is full. */
    readonly events: EventRecord[];
    /** Sequence number of the last event published, buffered or not. */
    eventSeq: number;
}

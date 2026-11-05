import { z } from 'zod';

import {
    AgentId,
    AgentPermanentId,
    Diagnostic,
    FolderId,
    MemberId,
    PageQuery,
    RevisionId,
    Timestamp,
    pageOf,
    valueSet,
} from './common';
import { MAX_BOOK_SOURCE_LENGTH } from './constants';
import { KNOWN_CAPABILITIES } from './capabilities/capability';
import { defineRoute } from './route';

export const AGENT_VISIBILITIES = ['public', 'private', 'unlisted'] as const;
export const AgentVisibility = z.enum(AGENT_VISIBILITIES);
export type AgentVisibility = z.infer<typeof AgentVisibility>;

export const AGENT_RUN_STATES = ['idle', 'running', 'stopped', 'error'] as const;
export const AgentRunState = z.enum(AGENT_RUN_STATES);
export type AgentRunState = z.infer<typeof AgentRunState>;

/**
 * Who defines the agent, as the Reborn engine models it. `content`: the project's own agents, which do its work.
 * `core`: Chatter, Adam, Tasker, Router, Fixer and Teacher, which the engine prepares but which are ordinary, editable
 * project Books. `system`: Expert and any other agent the engine itself defines, with no project Book. Origin grants
 * no privilege and changes no permission, but a `system` agent belongs to the engine: changing, deleting or restoring
 * it, or saving its source, is 409 `agent-engine-owned`.
 */
export const AGENT_ORIGINS = ['content', 'core', 'system'] as const;
export const AgentOrigin = z.enum(AGENT_ORIGINS);
export type AgentOrigin = z.infer<typeof AgentOrigin>;

/** A `#rrggbb` colour; anything richer could smuggle CSS into the UI. */
export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** Book source text. May be empty or invalid; validity is reported as diagnostics, not as a schema error. */
export const BookSource = z.string().max(MAX_BOOK_SOURCE_LENGTH);

/** Derived by the engine from the book source; read-only through this API. */
export const AgentProfile = z.strictObject({
    fullname: z.string().max(256),
    description: z.string().max(4096),
    /** Same-origin path or `data:` URL: the UI's CSP loads images from nowhere else. */
    avatarUrl: z.string().max(2048).nullable(),
    color: HexColor.nullable(),
    initialMessage: z.string().max(4096).nullable(),
});
export type AgentProfile = z.infer<typeof AgentProfile>;

export const Agent = z.strictObject({
    id: AgentId,
    permanentId: AgentPermanentId,
    name: z.string().min(1).max(256),
    /** `profile.description` is the agent's one-line role, which the UI shows for built-in agents. */
    profile: AgentProfile,
    origin: AgentOrigin,
    visibility: AgentVisibility,
    folderId: FolderId.nullable(),
    currentRevisionId: RevisionId,
    createdBy: MemberId,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    deletedAt: Timestamp.nullable(),
});
export type Agent = z.infer<typeof Agent>;
export const AgentPage = pageOf(Agent);

export const AGENT_SORTS = ['name', '-name', 'updatedAt', '-updatedAt', 'createdAt', '-createdAt'] as const;
export const AGENT_DELETED_FILTERS = ['exclude', 'include', 'only'] as const;

export const AgentListQuery = PageQuery.extend({
    /** Matches name, full name and description, case-insensitively. */
    q: z.string().min(1).max(256).optional(),
    folderId: FolderId.optional(),
    visibility: AgentVisibility.optional(),
    status: AgentRunState.optional(),
    /** One origin or a comma-separated set, e.g. `core,system` for the built-in agents. */
    origin: valueSet(AGENT_ORIGINS).optional(),
    deleted: z.enum(AGENT_DELETED_FILTERS).default('exclude'),
    sort: z.enum(AGENT_SORTS).default('name'),
});

export const AgentParams = z.strictObject({ agentId: AgentId });

export const CreateAgentBody = z.strictObject({
    source: BookSource,
    folderId: FolderId.optional(),
    visibility: AgentVisibility.optional(),
});

export const UpdateAgentBody = z.strictObject({
    visibility: AgentVisibility.optional(),
    /** `null` moves the agent out of its folder. */
    folderId: FolderId.nullable().optional(),
});

export const AgentSource = z.strictObject({
    agentId: AgentId,
    revisionId: RevisionId,
    source: BookSource,
    updatedAt: Timestamp,
});
export type AgentSource = z.infer<typeof AgentSource>;

/** `baseRevisionId` is the revision the edit started from; a newer current revision is a 409 `revision-conflict`. */
export const UpdateAgentSourceBody = z.strictObject({ source: BookSource, baseRevisionId: RevisionId });

export const RevisionSummary = z.strictObject({
    id: RevisionId,
    agentId: AgentId,
    createdBy: MemberId,
    createdAt: Timestamp,
});
export type RevisionSummary = z.infer<typeof RevisionSummary>;
export const RevisionPage = pageOf(RevisionSummary);

export const Revision = z.strictObject({
    id: RevisionId,
    agentId: AgentId,
    source: BookSource,
    createdBy: MemberId,
    createdAt: Timestamp,
});
export type Revision = z.infer<typeof Revision>;

export const RevisionParams = z.strictObject({ agentId: AgentId, revisionId: RevisionId });

export const ValidateBookBody = z.strictObject({ source: BookSource });
export const Diagnostics = z.array(Diagnostic);

export const AgentRunStatus = z.strictObject({ state: AgentRunState, since: Timestamp });
export type AgentRunStatus = z.infer<typeof AgentRunStatus>;

export const AGENT_ROUTES = {
    listAgents: defineRoute({
        id: 'listAgents',
        method: 'GET',
        path: '/agents',
        summary: 'List agents',
        permission: 'agents.read',
        query: AgentListQuery,
        responses: { 200: { kind: 'json', schema: AgentPage } },
    }),
    createAgent: defineRoute({
        id: 'createAgent',
        method: 'POST',
        path: '/agents',
        summary: 'Create an agent from book source; a book with an error diagnostic is refused and nothing is stored',
        permission: 'agents.write',
        body: { kind: 'json', schema: CreateAgentBody },
        responses: { 201: { kind: 'json', schema: Agent } },
        problems: ['invalid-book'],
    }),
    validateAgentSource: defineRoute({
        id: 'validateAgentSource',
        method: 'POST',
        path: '/agents/validate',
        summary: 'Validate book source without storing it',
        permission: 'agents.write',
        capability: KNOWN_CAPABILITIES.bookEditor,
        body: { kind: 'json', schema: ValidateBookBody },
        responses: { 200: { kind: 'json', schema: Diagnostics } },
    }),
    getAgent: defineRoute({
        id: 'getAgent',
        method: 'GET',
        path: '/agents/{agentId}',
        summary: 'Get an agent, including a soft-deleted one',
        permission: 'agents.read',
        params: AgentParams,
        responses: { 200: { kind: 'json', schema: Agent } },
    }),
    updateAgent: defineRoute({
        id: 'updateAgent',
        method: 'PATCH',
        path: '/agents/{agentId}',
        summary: "Change an agent's visibility or folder",
        permission: 'agents.write',
        capability: KNOWN_CAPABILITIES.agentManagement,
        params: AgentParams,
        body: { kind: 'json', schema: UpdateAgentBody },
        responses: { 200: { kind: 'json', schema: Agent } },
        problems: ['agent-deleted', 'agent-engine-owned'],
    }),
    deleteAgent: defineRoute({
        id: 'deleteAgent',
        method: 'DELETE',
        path: '/agents/{agentId}',
        summary: 'Soft-delete an agent (idempotent)',
        permission: 'agents.delete',
        params: AgentParams,
        responses: { 200: { kind: 'json', schema: Agent } },
        problems: ['agent-engine-owned'],
    }),
    restoreAgent: defineRoute({
        id: 'restoreAgent',
        method: 'POST',
        path: '/agents/{agentId}/restore',
        summary: 'Restore a soft-deleted agent (idempotent)',
        permission: 'agents.delete',
        capability: KNOWN_CAPABILITIES.agentManagement,
        params: AgentParams,
        responses: { 200: { kind: 'json', schema: Agent } },
        problems: ['agent-engine-owned'],
    }),
    getAgentSource: defineRoute({
        id: 'getAgentSource',
        method: 'GET',
        path: '/agents/{agentId}/source',
        summary: 'Get the current book source',
        permission: 'agents.read',
        params: AgentParams,
        responses: { 200: { kind: 'json', schema: AgentSource } },
    }),
    updateAgentSource: defineRoute({
        id: 'updateAgentSource',
        method: 'PUT',
        path: '/agents/{agentId}/source',
        summary: 'Save new book source as a new revision',
        permission: 'agents.write',
        capability: KNOWN_CAPABILITIES.bookEditor,
        params: AgentParams,
        body: { kind: 'json', schema: UpdateAgentSourceBody },
        responses: { 200: { kind: 'json', schema: AgentSource } },
        problems: ['revision-conflict', 'invalid-book', 'agent-deleted', 'agent-engine-owned'],
    }),
    listAgentRevisions: defineRoute({
        id: 'listAgentRevisions',
        method: 'GET',
        path: '/agents/{agentId}/revisions',
        summary: 'List revisions, newest first',
        permission: 'agents.read',
        capability: KNOWN_CAPABILITIES.bookEditor,
        params: AgentParams,
        query: PageQuery,
        responses: { 200: { kind: 'json', schema: RevisionPage } },
    }),
    getAgentRevision: defineRoute({
        id: 'getAgentRevision',
        method: 'GET',
        path: '/agents/{agentId}/revisions/{revisionId}',
        summary: 'Get one revision with its source',
        permission: 'agents.read',
        capability: KNOWN_CAPABILITIES.bookEditor,
        params: RevisionParams,
        responses: { 200: { kind: 'json', schema: Revision } },
    }),
    getAgentStatus: defineRoute({
        id: 'getAgentStatus',
        method: 'GET',
        path: '/agents/{agentId}/status',
        summary: 'Get the run state',
        permission: 'agents.read',
        params: AgentParams,
        responses: { 200: { kind: 'json', schema: AgentRunStatus } },
        draft: true,
    }),
    startAgent: defineRoute({
        id: 'startAgent',
        method: 'POST',
        path: '/agents/{agentId}/start',
        summary: 'Start an agent (idempotent)',
        permission: 'agents.run',
        params: AgentParams,
        responses: { 200: { kind: 'json', schema: AgentRunStatus } },
        problems: ['agent-deleted'],
        draft: true,
    }),
    stopAgent: defineRoute({
        id: 'stopAgent',
        method: 'POST',
        path: '/agents/{agentId}/stop',
        summary: 'Stop an agent (idempotent)',
        permission: 'agents.run',
        params: AgentParams,
        responses: { 200: { kind: 'json', schema: AgentRunStatus } },
        draft: true,
    }),
} as const;

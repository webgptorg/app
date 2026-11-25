import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { EngineApiClient, ReadAiTool, ReadAiToolSignIn } from '@ptbk/engine-api';
import { queryOptions, useQuery } from '@tanstack/react-query';

import { unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import type { FeatureRequirement } from '../../app/registry/feature';

/** Seeing the tools and checking them; who oversees the project. */
export const AI_TOOLS_READ: FeatureRequirement = {
    capability: KNOWN_CAPABILITIES.aiTools,
    permission: 'ai-tools.read',
};
/** Signing a tool in, giving it a key, signing it out: the owner's, behind a fresh passkey. */
export const AI_TOOLS_MANAGE: FeatureRequirement = {
    capability: KNOWN_CAPABILITIES.aiTools,
    permission: 'ai-tools.manage',
};

/** While a check or a sign-in runs on the engine, and as a fallback when the event stream is down. */
export const AI_TOOLS_POLL_MS = 2_000;

export const aiToolKeys = {
    all: ['ai-tools'] as const,
    list: () => [...aiToolKeys.all, 'list'] as const,
    signIn: (signInId: string) => [...aiToolKeys.all, 'sign-in', signInId] as const,
};

export function aiToolsQueryOptions(engineApi: EngineApiClient) {
    return queryOptions({
        queryKey: aiToolKeys.list(),
        queryFn: async ({ signal }) => unwrap(await engineApi.aiTools.list(signal)).items,
        refetchInterval: (query) => (query.state.data?.some(({ checking }) => checking) ? AI_TOOLS_POLL_MS : false),
    });
}

export function useAiTools(enabled = true) {
    return useQuery({ ...aiToolsQueryOptions(useEngineApi()), enabled });
}

/** A tool that cannot work until the owner signs it in again: what Home and the chat error point to. */
export function needsSignIn(tool: ReadAiTool): boolean {
    return tool.status === 'needs-sign-in';
}

/**
 * Whether the sign-in can move without the owner: the engine verifies, or the provider has yet to confirm a device
 * login. The dialog then asks again soon.
 */
export function isSignInSettling(signIn: ReadAiToolSignIn | undefined): boolean {
    if (signIn === undefined) return false;
    if (signIn.status === 'working') return true;
    const prompt = signIn.prompt;
    return prompt?.kind === 'harness-login' && (prompt.status === 'waiting' || prompt.status === 'verifying');
}

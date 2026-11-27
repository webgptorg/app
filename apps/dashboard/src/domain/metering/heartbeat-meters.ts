import { measureSummedPerProject, type Meter } from './meter';

/**
 * Heartbeat `agents`: every agent that exists in the project, as the engine defines it today. Whether disabled or
 * archived agents should count is open (ADR 0025); a narrower count would be a new heartbeat field and a new meter.
 */
export const agentsMeter: Meter = {
    id: 'agents',
    quotas: { org: 'agents.max', project: 'agents.per-project.max' },
    createdBy: 'engine',
    measure: (facts) => measureSummedPerProject(facts, (project) => project.heartbeat?.agents ?? null),
};

/**
 * Heartbeat `members`: the people registered on the engine. Summed over projects, because the dashboard cannot tell
 * that two projects share a person; `people` is the de-duplicated count of those it invited.
 */
export const membersMeter: Meter = {
    id: 'members',
    quotas: { org: 'members.max', project: 'members.per-project.max' },
    createdBy: 'engine',
    measure: (facts) => measureSummedPerProject(facts, (project) => project.heartbeat?.members ?? null),
};

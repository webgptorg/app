import { measureSummedPerProject, type Meter } from './meter';

/** The organization's active engines, which the screens call projects; `engines.max` predates the name. */
export const projectsMeter: Meter = {
    id: 'projects',
    quotas: { org: 'engines.max', project: null },
    createdBy: 'dashboard',
    measure: (facts) => measureSummedPerProject(facts, () => 1),
};

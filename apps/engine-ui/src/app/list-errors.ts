import { classifyApiError } from './api-errors';
import { isForbidden, isStepUpRequired } from './mutations';

/** Refusals a route explains as a whole page ("not allowed", "confirm it is you") rather than inside a section. */
export function isPageLevelFailure(error: unknown): boolean {
    const failure = classifyApiError(error);
    return isForbidden(failure) || isStepUpRequired(failure);
}

/** An expired or foreign cursor: the list starts again from its first page instead of showing an error. */
export function isInvalidCursor(error: unknown): boolean {
    const failure = classifyApiError(error);
    return failure.kind === 'problem' && failure.problem.code === 'invalid-cursor';
}

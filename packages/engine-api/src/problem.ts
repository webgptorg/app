import type { AiToolId, Diagnostic, ProblemDetails } from './common';
import type { Permission } from './permissions';
import { PROBLEM_STATUS, problemType } from './problem-codes';
import type { ProblemCode } from './problem-codes';

export interface ProblemExtras {
    readonly detail?: string;
    readonly errors?: readonly { readonly path: string; readonly message: string }[];
    readonly requiredPermission?: Permission;
    readonly diagnostics?: readonly Diagnostic[];
    readonly attemptsRemaining?: number;
    readonly aiToolId?: AiToolId;
}

/** A problem with the status, `type` and title its code always has, so engines cannot drift apart. */
export function createProblem(code: ProblemCode, extras: ProblemExtras = {}): ProblemDetails {
    const title = code.replaceAll('-', ' ');
    return {
        type: problemType(code),
        title: title.charAt(0).toUpperCase() + title.slice(1),
        status: PROBLEM_STATUS[code],
        code,
        ...(extras.detail === undefined ? {} : { detail: extras.detail }),
        ...(extras.errors === undefined ? {} : { errors: [...extras.errors] }),
        ...(extras.requiredPermission === undefined ? {} : { requiredPermission: extras.requiredPermission }),
        ...(extras.diagnostics === undefined ? {} : { diagnostics: [...extras.diagnostics] }),
        ...(extras.attemptsRemaining === undefined ? {} : { attemptsRemaining: extras.attemptsRemaining }),
        ...(extras.aiToolId === undefined ? {} : { aiToolId: extras.aiToolId }),
    };
}

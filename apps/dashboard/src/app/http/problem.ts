import { PROBLEM_CONTENT_TYPE, type Problem } from '../../shared/api/problem';

export type ProblemStatus = 400 | 401 | 403 | 404 | 413 | 429 | 500 | 503;

const TITLES: Readonly<Record<ProblemStatus, string>> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    413: 'Content Too Large',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    503: 'Service Unavailable',
};

export function problemResponse(status: ProblemStatus, code: string): Response {
    const problem: Problem = {
        type: 'about:blank',
        title: TITLES[status],
        status,
        code,
    };
    return new Response(JSON.stringify(problem), {
        status,
        headers: { 'Content-Type': PROBLEM_CONTENT_TYPE },
    });
}

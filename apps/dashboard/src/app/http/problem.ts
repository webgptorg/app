import { PROBLEM_CONTENT_TYPE, type Problem } from '../../shared/api/problem';

const TITLES: Readonly<Record<number, string>> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    413: 'Content Too Large',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    503: 'Service Unavailable',
};

export function problemResponse(status: number, code: string, detail?: string): Response {
    const problem: Problem = {
        type: 'about:blank',
        title: TITLES[status] ?? 'Error',
        status,
        code,
        ...(detail === undefined ? {} : { detail }),
    };
    return new Response(JSON.stringify(problem), {
        status,
        headers: { 'Content-Type': PROBLEM_CONTENT_TYPE },
    });
}

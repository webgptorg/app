import type { PublicFaceFetcher, PublicFaceResponse } from '../domain/abuse/public-face';

export interface FakePublicFaceFetcher extends PublicFaceFetcher {
    /** What each URL answers; a URL not listed fails like an unreachable host. */
    readonly routes: Map<string, Partial<PublicFaceResponse> | 'hang'>;
    readonly requested: string[];
}

/** The mock engine's anonymous face: `/` redirects to the sign-in page. */
export function mockEngineFace(hostname: string): [string, Partial<PublicFaceResponse>][] {
    return [
        [`https://${hostname}/`, { status: 303, location: '/auth/sign-in' }],
        [
            `https://${hostname}/auth/sign-in`,
            {
                status: 200,
                contentType: 'text/html; charset=utf-8',
                body: '<!doctype html>\n<html><head>\n<title>Sign in · Promptbook mock engine</title>\n</head></html>',
            },
        ],
    ];
}

export function createFakePublicFaceFetcher(): FakePublicFaceFetcher {
    const routes = new Map<string, Partial<PublicFaceResponse> | 'hang'>();
    const requested: string[] = [];
    return {
        routes,
        requested,
        get(url, signal) {
            requested.push(url);
            const route = routes.get(url);
            if (route === undefined) return Promise.reject(new TypeError('fetch failed'));
            if (route === 'hang') {
                return new Promise((_, reject) => {
                    signal.addEventListener('abort', () => {
                        reject(signal.reason as Error);
                    });
                });
            }
            return Promise.resolve({ status: 200, location: null, contentType: null, body: '', ...route });
        },
    };
}

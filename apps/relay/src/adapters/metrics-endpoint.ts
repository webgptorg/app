import { createHash, timingSafeEqual } from 'node:crypto';

import { PROMETHEUS_CONTENT_TYPE } from './prometheus-metrics';

/** `GET /metrics` on the relay's own hostname (ADR 0008, I-04). */
export interface MetricsEndpoint {
    /** The `Authorization` header carries the metrics token. */
    authorize(authorization: string | undefined): boolean;
    /** The current metrics in the Prometheus text format. */
    render(): string;
    readonly contentType: string;
}

const BEARER = /^Bearer ([\x21-\x7e]{1,256})$/i;

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * Compares digests, so the comparison takes the same time whatever the length or content of the presented token.
 */
export function createMetricsEndpoint(options: {
    readonly token: { reveal(): string };
    readonly render: () => string;
}): MetricsEndpoint {
    const expected = digest(options.token.reveal());
    return {
        authorize(authorization) {
            const presented = BEARER.exec(authorization ?? '')?.[1];
            return timingSafeEqual(digest(presented ?? ''), expected) && presented !== undefined;
        },
        render: options.render,
        contentType: PROMETHEUS_CONTENT_TYPE,
    };
}

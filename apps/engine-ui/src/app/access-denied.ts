/**
 * Thrown from a route's `beforeLoad` when the route cannot be shown, and rendered by the route error component as a
 * calm explanation instead of a failure: the engine does not advertise the feature, or the member lacks a permission.
 */
export class AccessDeniedError extends Error {
    readonly reason: 'unavailable' | 'no-access';

    constructor(reason: 'unavailable' | 'no-access') {
        super(reason === 'unavailable' ? 'Feature not available on this engine' : 'No access');
        this.name = 'AccessDeniedError';
        this.reason = reason;
    }
}

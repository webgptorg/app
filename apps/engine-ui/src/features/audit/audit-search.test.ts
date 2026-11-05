import { describe, expect, it } from 'vitest';

import { auditListParams, AuditSearch, hasAuditFilters } from './audit-search';

describe('AuditSearch', () => {
    it('keeps valid filters and drops invalid ones one by one', () => {
        expect(
            AuditSearch.parse({
                memberId: 'member-1',
                action: 'agent.clone',
                targetKind: 'agent',
                targetId: 'line\nbreak',
                outcome: 'denied',
                from: '2026-02-29',
                to: '2026-03-01',
                cursor: 'abc',
            }),
        ).toEqual({ memberId: 'member-1', targetKind: 'agent', outcome: 'denied', to: '2026-03-01', cursor: 'abc' });
        expect(AuditSearch.parse({ from: '2028-02-29', to: '2026-13-01' })).toEqual({ from: '2028-02-29' });
        expect(AuditSearch.parse({ from: 20260101, outcome: ['success'] })).toEqual({});
    });

    it('reads an all-digit ID, which the router parses as a number, as a string', () => {
        expect(AuditSearch.parse({ memberId: 12345, targetId: 7 })).toEqual({ memberId: '12345', targetId: '7' });
    });
});

describe('auditListParams', () => {
    it("sends whole local days as UTC instants, with the engine's exclusive end on the next day", () => {
        const params = auditListParams(AuditSearch.parse({ from: '2026-10-25', to: '2026-10-25' }));
        expect(params).toEqual({
            limit: 50,
            from: new Date(2026, 9, 25).toISOString(),
            to: new Date(2026, 9, 26).toISOString(),
        });
        expect(auditListParams(AuditSearch.parse({ to: '2026-12-31' })).to).toBe(new Date(2027, 0, 1).toISOString());
    });

    it('passes every filter and the cursor, and only those set', () => {
        const search = AuditSearch.parse({ memberId: 'm', action: 'wallet.record.update', targetId: 't', cursor: 'c' });
        expect(auditListParams(search)).toEqual({
            limit: 50,
            memberId: 'm',
            action: 'wallet.record.update',
            targetId: 't',
            cursor: 'c',
        });
        expect(hasAuditFilters(search)).toBe(true);
        expect(hasAuditFilters(AuditSearch.parse({ cursor: 'c' }))).toBe(false);
    });
});

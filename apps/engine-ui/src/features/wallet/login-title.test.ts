import { describe, expect, it } from 'vitest';

import { loginTitle } from './login-title';

describe('loginTitle', () => {
    it("shows the engine's derived name as the site alone", () => {
        expect(loginTitle('github.com · ad…@example.com', 'github.com')).toEqual({ title: 'github.com', site: null });
        expect(loginTitle('github.com', 'github.com')).toEqual({ title: 'github.com', site: null });
    });

    it('leads with a name the owner gave it and keeps the site once beside it', () => {
        expect(loginTitle('Work GitHub', 'github.com')).toEqual({ title: 'Work GitHub', site: 'github.com' });
        expect(loginTitle('github.company.example', 'github.com')).toEqual({
            title: 'github.company.example',
            site: 'github.com',
        });
    });
});

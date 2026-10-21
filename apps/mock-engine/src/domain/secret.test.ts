import { describe, expect, it } from 'vitest';

import { oneTimeSecret, secret } from './secret';

describe('secret', () => {
    it('reveals its value but never prints it', () => {
        const value = secret('hunter2');
        expect(value.reveal()).toBe('hunter2');
        expect(JSON.stringify({ value })).not.toContain('hunter2');
    });
});

describe('oneTimeSecret', () => {
    it('hands out its value once, then nothing', () => {
        const value = oneTimeSecret('link-code-value');
        expect(value.take()).toBe('link-code-value');
        expect(value.take()).toBeNull();
    });

    it('never prints its value', () => {
        const value = oneTimeSecret('link-code-value');
        expect(JSON.stringify({ value })).not.toContain('link-code-value');
    });
});

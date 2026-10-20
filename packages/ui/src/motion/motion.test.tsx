import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { REDUCED_MOTION, setMedia } from '../testing/dom-gaps';
import { loadMotion, useMotion } from './lazy-motion';
import { prefersReducedMotion, useReducedMotion } from './reduced-motion';
import { canUseViewTransitions, withViewTransition } from './view-transition';

describe('reduced motion', () => {
    it('follows the media query, live', () => {
        const { result } = renderHook(() => useReducedMotion());
        expect(result.current).toBe(false);
        act(() => {
            setMedia(REDUCED_MOTION, true);
        });
        expect(result.current).toBe(true);
        expect(prefersReducedMotion()).toBe(true);
    });

    it('answers false without matchMedia', () => {
        expect(prefersReducedMotion(undefined)).toBe(false);
        const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
        Reflect.deleteProperty(window, 'matchMedia');
        try {
            expect(prefersReducedMotion()).toBe(false);
            const { result } = renderHook(() => useReducedMotion());
            expect(result.current).toBe(false);
        } finally {
            if (original !== undefined) Object.defineProperty(window, 'matchMedia', original);
        }
    });
});

describe('view transitions', () => {
    it('run the update inside a transition when supported and motion is allowed', () => {
        const startViewTransition = vi.fn((update: () => void) => {
            update();
        });
        const update = vi.fn();
        withViewTransition(update, { startViewTransition }, () => ({ matches: false }));
        expect(startViewTransition).toHaveBeenCalledOnce();
        expect(update).toHaveBeenCalledOnce();
    });

    it('are skipped under reduced motion and where unsupported, still running the update once', () => {
        const startViewTransition = vi.fn();
        const update = vi.fn();
        withViewTransition(update, { startViewTransition }, () => ({ matches: true }));
        withViewTransition(update, {}, () => ({ matches: false }));
        withViewTransition(update, undefined);
        expect(startViewTransition).not.toHaveBeenCalled();
        expect(update).toHaveBeenCalledTimes(3);
        expect(canUseViewTransitions({ startViewTransition }, () => ({ matches: true }))).toBe(false);
        expect(canUseViewTransitions(document)).toBe(typeof document.startViewTransition === 'function');
        withViewTransition(update);
        expect(update).toHaveBeenCalledTimes(4);
    });
});

describe('lazy motion', () => {
    it('loads the motion module once, on demand', async () => {
        const first = loadMotion();
        expect(loadMotion()).toBe(first);
        expect((await first).motion).toBeDefined();
    });

    it('exposes the module to components, and nothing under reduced motion', async () => {
        function Probe() {
            const motion = useMotion();
            return <p>{motion === null ? 'static' : 'animated'}</p>;
        }
        const { unmount } = render(<Probe />);
        expect(await screen.findByText('animated')).toBeDefined();
        unmount();

        setMedia(REDUCED_MOTION, true);
        render(<Probe />);
        await waitFor(() => {
            expect(screen.getByText('static')).toBeDefined();
        });
    });

    it('ignores a load that finishes after unmount', async () => {
        function Probe() {
            useMotion();
            return null;
        }
        const { unmount } = render(<Probe />);
        unmount();
        await loadMotion();
    });
});

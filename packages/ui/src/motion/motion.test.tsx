import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { REDUCED_MOTION, setMedia } from '../testing/dom-gaps';
import { loadMotion, useMotion } from './lazy-motion';
import { prefersReducedMotion, useReducedMotion } from './reduced-motion';
import { canUseViewTransitions, viewTransitionName, viewTransitionStyle, withViewTransition } from './view-transition';

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

describe('view transition names', () => {
    it('are CSS identifiers that keep distinct ids distinct', () => {
        expect(viewTransitionName('task-title', 'task-ship-billing')).toBe('ptbk-task-title--task-ship-billing');
        expect(viewTransitionName('task', 'a b')).toBe('ptbk-task--a_20_b');
        expect(viewTransitionName('task', 'a_b')).not.toBe(viewTransitionName('task', 'a b'));
        expect(viewTransitionName('task', '1/é')).toBe('ptbk-task--1_2f__e9_');
        expect(viewTransitionName('task', '😀')).toBe('ptbk-task--_1f600_');
    });

    it('apply through a style object, so the CSSOM sets them', () => {
        expect(viewTransitionStyle('agent', 'ada')).toEqual({ viewTransitionName: 'ptbk-agent--ada' });
        render(<h1 style={viewTransitionStyle('agent', 'ada')}>{'Ada'}</h1>);
        expect(screen.getByRole('heading').style.getPropertyValue('view-transition-name')).toBe('ptbk-agent--ada');
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

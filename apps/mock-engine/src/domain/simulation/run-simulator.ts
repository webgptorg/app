import type { InMemoryEngineController } from '@ptbk/engine-api/in-memory';

import type { Clock } from '../clock';
import type { FaultPlan } from '../faults/fault-plan';
import type { ToolTemplate } from '../state/capability-texts';
import { MODELS, OUTPUTS, PROJECT_FILES, PROJECTS, RUN_ERRORS, RUNNERS, TASKS, TOOLS } from '../state/capability-texts';
import { generatePng } from '../state/png';
import { hex, unifiedDiff, usageFor } from '../state/run-content';
import type { SeededSequence } from '../state/seed-random';
import { createSeededSequence, hashSeed } from '../state/seed-random';

/** How often a simulated run fails when the fault plan does not set `runFailureRate`. */
export const BASE_RUN_FAILURE_RATE = 0.12;
const OUTPUT_FILE_RATE = 0.25;
const PROJECT_CHANGE_RATE = 0.15;
/** A scripted run makes one transition per simulated second, so e2e can step through it exactly. */
const SCRIPTED_STEP_MS = 1000;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export interface RunScriptStep {
    readonly text: string;
    /** A tool call the step makes; it ends `error` on the last step of a failed run. */
    readonly toolName?: string | undefined;
}

export interface RunScript {
    readonly outcome: 'completed' | 'failed';
    readonly steps: readonly RunScriptStep[];
}

export interface RunSimulatorDeps {
    readonly controller: InMemoryEngineController;
    /** The simulation's clock: every delay here is simulated time. */
    readonly clock: Clock;
    readonly sequence: SeededSequence;
    readonly faults: () => FaultPlan;
    readonly onError: (error: unknown) => void;
}

export interface RunSimulator {
    /** Looks at a run that was queued or changed, and takes it on if it is a non-chat run nobody drives yet. */
    consider(runId: string): void;
    /** Makes the run follow `script` once it starts. */
    script(runId: string, script: RunScript): void;
    /** Takes on runs `stuckQueue` held back, once the fault plan lets them go. */
    release(): void;
    stop(): void;
}

interface Step {
    readonly delayMs: number;
    readonly apply: () => void;
}

interface ProgressItem {
    readonly id: string;
    readonly text: string;
    status: 'pending' | 'completed';
}

/**
 * Drives runs the way a runner would, only through the core's levers: `queued → running`, a progress card whose
 * items complete one by one, tool calls `pending → partial → complete | error`, then `completed` (sometimes with an
 * output file or a commit) or `failed`. A cancel request ends the run as `cancelled` at its next step. Chat runs are
 * left to the core, which ends them with their reply.
 */
export function createRunSimulator(deps: RunSimulatorDeps): RunSimulator {
    const { controller, clock, sequence } = deps;
    const timers = new Map<string, () => void>();
    const stuck = new Set<string>();
    const scripts = new Map<string, RunScript>();
    /** The tool call in flight, so a cancel can end it. */
    const inFlight = new Map<string, { id: string; name: string; startedAt: string | null }>();
    let stopped = false;

    const iso = (): string => new Date(clock.nowMs()).toISOString();

    function guarded(fn: () => void): () => void {
        return () => {
            if (stopped) return;
            try {
                fn();
            } catch (error) {
                deps.onError(error);
            }
        };
    }

    function schedule(runId: string, delayMs: number, fn: () => void): void {
        timers.get(runId)?.();
        timers.set(
            runId,
            clock.setTimeout(
                guarded(() => {
                    timers.delete(runId);
                    fn();
                }),
                delayMs,
            ),
        );
    }

    function finished(runId: string): void {
        timers.get(runId)?.();
        timers.delete(runId);
        scripts.delete(runId);
        inFlight.delete(runId);
        stuck.delete(runId);
    }

    /** Ends a run whose cancel was requested, the tool call it was in ending with it. */
    function cancel(runId: string): void {
        const call = inFlight.get(runId);
        if (call !== undefined) {
            controller.reportRunProgress(runId, {
                toolCall: { ...call, state: 'error', durationMs: null, logs: 'Cancelled.\n' },
            });
        }
        controller.advanceRun(runId);
        finished(runId);
    }

    /** Runs the steps in order, checking before each that the run still goes and nobody asked to cancel it. */
    function play(runId: string, steps: readonly Step[], index = 0): void {
        const step = steps[index];
        if (step === undefined) {
            finished(runId);
            return;
        }
        schedule(runId, step.delayMs, () => {
            const run = controller.getRun(runId);
            if (run === undefined || TERMINAL.has(run.status)) {
                finished(runId);
                return;
            }
            if (run.cancelRequestedAt !== null) {
                cancel(runId);
                return;
            }
            step.apply();
            play(runId, steps, index + 1);
        });
    }

    function delay(scripted: boolean, min: number, max: number): number {
        return scripted ? SCRIPTED_STEP_MS : sequence.int(min, max);
    }

    function plan(runId: string, title: string, texts: readonly string[], script: RunScript | undefined): Step[] {
        const scripted = script !== undefined;
        const fails = scripted
            ? script.outcome === 'failed'
            : sequence.chance(deps.faults().runFailureRate ?? BASE_RUN_FAILURE_RATE);
        const items: ProgressItem[] = texts.map((text, index) => ({
            id: `step-${String(index + 1)}`,
            text,
            status: 'pending',
        }));
        const progress = () => {
            const open = items.filter((item) => item.status === 'pending');
            return {
                title,
                now: open[0]?.text ?? null,
                next: open[1]?.text ?? null,
                items: items.map((item) => ({ ...item })),
            };
        };
        const steps: Step[] = [];
        for (const [index, item] of items.entries()) {
            const last = index === items.length - 1;
            const toolName = scripted
                ? script.steps[index]?.toolName
                : sequence.chance(0.7)
                  ? sequence.pick(TOOLS).name
                  : undefined;
            if (toolName !== undefined) {
                const template: ToolTemplate = TOOLS.find(({ name }) => name === toolName) ?? {
                    name: toolName,
                    ok: `$ ${toolName}\n→ done\n`,
                    failed: `$ ${toolName}\n✗ failed\n`,
                };
                const call: { id: string; name: string; startedAt: string | null } = {
                    id: sequence.id('tool'),
                    name: toolName,
                    startedAt: null,
                };
                const errors = fails && last;
                steps.push(
                    {
                        delayMs: delay(scripted, 1000, 5000),
                        apply: () => {
                            inFlight.set(runId, call);
                            controller.reportRunProgress(runId, {
                                progress: progress(),
                                toolCall: { ...call, state: 'pending', durationMs: null, logs: '' },
                            });
                        },
                    },
                    {
                        delayMs: delay(scripted, 1000, 5000),
                        apply: () => {
                            call.startedAt = iso();
                            const logs = template.ok.split('\n')[0] ?? '';
                            controller.reportRunProgress(runId, {
                                toolCall: { ...call, state: 'partial', durationMs: null, logs: `${logs}\n` },
                            });
                        },
                    },
                    {
                        delayMs: delay(scripted, 2000, 40_000),
                        apply: () => {
                            inFlight.delete(runId);
                            controller.reportRunProgress(runId, {
                                toolCall: {
                                    ...call,
                                    state: errors ? 'error' : 'complete',
                                    durationMs: Math.max(
                                        0,
                                        Math.round(clock.nowMs() - Date.parse(call.startedAt ?? iso())),
                                    ),
                                    logs: errors ? template.failed : template.ok,
                                },
                            });
                        },
                    },
                );
            }
            if (fails && last) break;
            steps.push({
                delayMs: delay(scripted, 1000, 8000),
                apply: () => {
                    item.status = 'completed';
                    controller.reportRunProgress(runId, { progress: progress() });
                },
            });
        }
        steps.push({
            delayMs: delay(scripted, 1000, 5000),
            apply: () => {
                finish(runId, fails);
            },
        });
        return steps;
    }

    function finish(runId: string, fails: boolean): void {
        const run = controller.getRun(runId);
        if (run === undefined) return;
        const model = MODELS.find((candidate) => candidate === run.model) ?? 'gpt-5-mini';
        const usage = usageFor(
            sequence,
            model,
            Math.max(0, Math.round(clock.nowMs() - Date.parse(run.startedAt ?? run.queuedAt))),
        );
        if (fails) {
            controller.advanceRun(runId, { status: 'failed', error: sequence.pick(RUN_ERRORS) });
            return;
        }
        if (sequence.chance(PROJECT_CHANGE_RATE)) {
            const change = unifiedDiff([...new Set([sequence.pick(PROJECT_FILES), sequence.pick(PROJECT_FILES)])]);
            controller.addProjectChange(runId, {
                projectName: sequence.pick(PROJECTS),
                commitHash: hex(sequence, 40),
                changedFiles: change.changedFiles,
                diff: change.diff,
            });
        }
        controller.advanceRun(runId, { status: 'completed', usage });
        if (sequence.chance(OUTPUT_FILE_RATE)) addOutput(runId, run.agentId, run.createdBy);
    }

    function addOutput(runId: string, agentId: string, createdBy: string | null): void {
        const kind = sequence.pick(OUTPUTS);
        const owner = createdBy ?? controller.findAgents().find(({ id }) => id === agentId)?.createdBy;
        if (owner === undefined) return;
        // A child sequence per picture, so drawing it never shifts the simulation's own sequence.
        const picture = createSeededSequence(hashSeed(sequence.id('png')));
        const content = kind.name.endsWith('.png')
            ? generatePng(picture).then((bytes) => new Blob([bytes], { type: kind.contentType }))
            : Promise.resolve(new Blob([`# Run ${runId}\n\nDone at ${iso()}.\n`], { type: kind.contentType }));
        content
            .then((blob) =>
                controller.addFile({
                    name: kind.name,
                    contentType: kind.contentType,
                    content: blob,
                    purpose: 'output',
                    agentId,
                    runId,
                    createdBy: owner,
                }),
            )
            .catch(deps.onError);
    }

    function start(runId: string): void {
        const run = controller.getRun(runId);
        if (run === undefined || TERMINAL.has(run.status)) {
            finished(runId);
            return;
        }
        if (run.cancelRequestedAt !== null) {
            cancel(runId);
            return;
        }
        if (run.status === 'queued') {
            if (deps.faults().stuckQueue) {
                stuck.add(runId);
                return;
            }
            stuck.delete(runId);
            controller.advanceRun(runId);
            controller.reportRunProgress(runId, {
                runner: run.runner === 'in-memory' || run.runner === null ? sequence.pick(RUNNERS) : run.runner,
                model: run.model ?? sequence.pick(MODELS),
            });
        }
        const script = scripts.get(runId);
        const current = controller.getRun(runId)?.progress;
        const task = sequence.pick(TASKS);
        const title = script ? `Scripted run (${String(script.steps.length)} steps)` : (current?.title ?? task.title);
        const texts = script
            ? script.steps.map(({ text }) => text)
            : current
              ? current.items.filter(({ status }) => status === 'pending').map(({ text }) => text)
              : task.steps;
        play(runId, plan(runId, title, texts.length > 0 ? texts : ['Wrap up'], script));
    }

    return {
        consider(runId) {
            if (stopped || timers.has(runId)) return;
            const run = controller.getRun(runId);
            if (run === undefined || TERMINAL.has(run.status) || run.messageId !== null) return;
            if (stuck.has(runId) && run.cancelRequestedAt === null && deps.faults().stuckQueue) return;
            const scripted = scripts.has(runId);
            schedule(runId, scripted ? SCRIPTED_STEP_MS : sequence.int(2000, 15_000), () => {
                start(runId);
            });
        },
        script(runId, script) {
            scripts.set(runId, script);
            if (timers.has(runId))
                schedule(runId, SCRIPTED_STEP_MS, () => {
                    start(runId);
                });
        },
        release() {
            for (const runId of [...stuck]) {
                stuck.delete(runId);
                this.consider(runId);
            }
        },
        stop() {
            stopped = true;
            for (const cancelTimer of timers.values()) cancelTimer();
            timers.clear();
        },
    };
}

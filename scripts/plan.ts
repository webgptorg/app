// Status lives in each brief, not in a shared table: parallel agents would otherwise conflict on every update.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

interface Task {
    readonly id: string;
    readonly title: string;
    readonly milestone: string;
    readonly dependsOn: readonly string[];
    readonly status: string;
    readonly file: string;
}

const TASKS_DIR = join(import.meta.dirname, '..', 'docs', 'plan', 'tasks');
const STATUS_PATTERN = /^(todo|in progress \(.+\)|done \(#\d+\))$/;

function field(source: string, name: string): string | undefined {
    return new RegExp(`\\*\\*${name}:\\*\\*\\s*([^·\\n]+)`).exec(source)?.[1]?.trim();
}

function readTasks(): Task[] {
    return readdirSync(TASKS_DIR)
        .filter((file) => /^[A-Z]-\d{2}-.+\.md$/.test(file))
        .sort()
        .map((file) => {
            const source = readFileSync(join(TASKS_DIR, file), 'utf8');
            const heading = /^# ([A-Z]-\d{2})\. (.+)$/m.exec(source);
            if (!heading?.[1] || !heading[2]) throw new Error(`${file}: missing "# <ID>. <Title>" heading`);
            const dependsOn = (field(source, 'Depends on') ?? '—')
                .split(',')
                .map((part) => /[A-Z]-\d{2}/.exec(part)?.[0])
                .filter((id): id is string => id !== undefined);
            return {
                id: heading[1],
                title: heading[2],
                milestone: field(source, 'Milestone') ?? '?',
                dependsOn,
                status: field(source, 'Status') ?? 'missing',
                file,
            };
        });
}

function isDone(task: Task | undefined): boolean {
    return task?.status.startsWith('done') ?? false;
}

function validate(tasks: readonly Task[]): string[] {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    return tasks.flatMap((task) => [
        ...(STATUS_PATTERN.test(task.status) ? [] : [`${task.id}: invalid status "${task.status}"`]),
        ...task.dependsOn.filter((dep) => !byId.has(dep)).map((dep) => `${task.id}: depends on unknown task ${dep}`),
        ...(isDone(task) && task.dependsOn.some((dep) => !isDone(byId.get(dep)))
            ? [`${task.id}: done while a dependency is not`]
            : []),
    ]);
}

/** Wave = longest dependency chain below a task; tasks in the same wave can run in parallel. */
function computeWaves(tasks: readonly Task[]): Map<string, number> {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const waves = new Map<string, number>();
    const visiting = new Set<string>();
    const visit = (id: string): number => {
        const known = waves.get(id);
        if (known !== undefined) return known;
        if (visiting.has(id)) throw new Error(`dependency cycle through ${id}`);
        visiting.add(id);
        const deps = byId.get(id)?.dependsOn ?? [];
        const wave = deps.length === 0 ? 1 : 1 + Math.max(...deps.map(visit));
        visiting.delete(id);
        waves.set(id, wave);
        return wave;
    };
    for (const task of tasks) visit(task.id);
    return waves;
}

function printWaves(tasks: readonly Task[]): void {
    const waves = computeWaves(tasks);
    const max = Math.max(...waves.values());
    for (let wave = 1; wave <= max; wave++) {
        const ids = tasks.filter((task) => waves.get(task.id) === wave).map((task) => task.id);
        console.log(`Wave ${String(wave)}: ${ids.join(', ')}`);
    }
}

function printTable(tasks: readonly Task[]): void {
    console.log('| ID | Task | Milestone | Depends on | Status |');
    console.log('| --- | --- | --- | --- | --- |');
    for (const task of tasks) {
        const deps = task.dependsOn.join(', ') || '—';
        console.log(`| ${task.id} | ${task.title} | ${task.milestone} | ${deps} | ${task.status} |`);
    }
}

const { values } = parseArgs({
    options: { next: { type: 'boolean' }, check: { type: 'boolean' }, waves: { type: 'boolean' } },
});
const tasks = readTasks();
const problems = validate(tasks);
try {
    computeWaves(tasks);
} catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
}

if (values.check) {
    for (const problem of problems) console.error(problem);
    process.exit(problems.length === 0 ? 0 : 1);
}

if (values.waves) {
    printWaves(tasks);
} else if (values.next) {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const ready = tasks.filter(
        (task) => task.status === 'todo' && task.dependsOn.every((dep) => isDone(byId.get(dep))),
    );
    printTable(ready);
} else {
    printTable(tasks);
}

#!/usr/bin/env node
/**
 * deepclaude workflow — JSON-defined multi-agent DAG executor
 *
 * Workflow format (JSON):
 * {
 *   "name": "feature-dev",
 *   "cwd": "/path/to/project",        // optional, default: process.cwd()
 *   "autonomous": true,                // agents write files (default: false)
 *   "steps": [
 *     { "id": "research",  "role": "Researcher", "model": "flash", "task": "Research {{input}}" },
 *     { "id": "plan",      "role": "Planner",    "model": "pro",   "task": "Plan {{input}}",
 *       "needs": ["research"] },
 *     { "id": "code",      "role": "Coder",      "model": "flash", "task": "Implement the plan",
 *       "needs": ["plan"] },
 *     { "id": "test",      "role": "Tester",     "model": "flash", "task": "Write tests",
 *       "needs": ["plan"] },
 *     { "id": "review",    "role": "Reviewer",   "model": "pro",   "task": "Review all work",
 *       "needs": ["code", "test"] },
 *     { "id": "commit",    "role": "Git",        "model": "flash", "task": "git commit",
 *       "needs": ["review"], "condition": "APPROVED" }
 *   ]
 * }
 *
 * Usage:
 *   node scripts/workflow.js run <workflow.json> "<input>"
 *   node scripts/workflow.js run <workflow.json>          # uses workflow.input
 *   node scripts/workflow.js example                      # print example workflow
 *   deepclaude workflow run <file> "<input>"
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { runAgent, PRO_MODEL, FLASH_MODEL } from './lib/runner.js';
import { agentHeader, agentOutput, agentDone, phaseHeader, thinking, clearLine, success, error } from './lib/display.js';
import { emit } from './lib/events.js';

// ---------------------------------------------------------------------------
// Template interpolation: {{input}} {{stepId}} {{stepId.output}}
// ---------------------------------------------------------------------------

function interpolate(template, vars) {
    return template.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
        const parts = key.trim().split('.');
        let val = vars;
        for (const p of parts) val = val?.[p];
        return val ?? `{{${key}}}`;
    });
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

function resolveModel(spec) {
    if (!spec || spec === 'flash') return FLASH_MODEL;
    if (spec === 'pro')            return PRO_MODEL;
    return spec; // pass-through if explicit model ID
}

// ---------------------------------------------------------------------------
// Dependency resolution — topological sort
// ---------------------------------------------------------------------------

function readySteps(steps, completed, skipped) {
    const done = new Set([...completed, ...skipped]);
    return steps.filter(s => {
        if (done.has(s.id)) return false;
        const needs = s.needs || [];
        return needs.every(dep => done.has(dep));
    });
}

// ---------------------------------------------------------------------------
// Workflow executor
// ---------------------------------------------------------------------------

async function runWorkflow(workflow, input) {
    const { name = 'workflow', steps = [], cwd, autonomous = false } = workflow;
    const vars = { input, ...Object.fromEntries(steps.map(s => [s.id, { output: '' }])) };

    emit('workflow_start', { workflow: name, input, steps: steps.length });
    phaseHeader(`Workflow: ${name}`);
    console.log(`  Input : ${(input || '').substring(0, 100)}`);
    console.log(`  Steps : ${steps.map(s => s.id).join(' → ')}\n`);

    const completed = new Set();
    const skipped   = new Set();
    const outputs   = {};
    let   iteration = 0;
    const MAX_ROUNDS = steps.length + 1;

    while (completed.size + skipped.size < steps.length && iteration++ < MAX_ROUNDS) {
        const ready = readySteps(steps, completed, skipped);
        if (!ready.length) break;

        // Run all ready steps in parallel
        await Promise.all(ready.map(async (step) => {
            const { id, role = id, task, model, condition, retry = 0 } = step;

            // Condition check — skip if a required keyword isn't in the needed output
            if (condition) {
                const neededOutput = (step.needs || []).map(dep => outputs[dep] || '').join('\n');
                if (!neededOutput.toLowerCase().includes(condition.toLowerCase())) {
                    console.log(`  ⊘ Skipping [${id}] — condition "${condition}" not met\n`);
                    emit('step_skip', { step: id, condition });
                    skipped.add(id);
                    return;
                }
            }

            // Build context from dependency outputs
            const depContext = (step.needs || [])
                .map(dep => `### ${dep}\n${outputs[dep] || ''}`)
                .join('\n\n');

            // Interpolate task template
            const taskText = interpolate(task || `Complete step: ${id}`, { input, ...vars });

            agentHeader(role, resolveModel(model));
            thinking(role);
            emit('agent_start', { agent: role, step: id, model });
            const t0 = Date.now();

            let attempts = 0;
            let out = '';
            while (attempts <= retry) {
                try {
                    out = await runAgent({
                        role,
                        model: resolveModel(model),
                        context: depContext || undefined,
                        task: taskText,
                        autonomous,
                        cwd: cwd || process.cwd(),
                        onToken: (t) => process.stdout.write(t),
                    });
                    break;
                } catch (e) {
                    attempts++;
                    if (attempts > retry) {
                        emit('agent_error', { agent: role, step: id, error: e.message });
                        error(`[${id}] failed after ${attempts} attempt(s): ${e.message}`);
                        skipped.add(id);
                        return;
                    }
                    console.log(`  ↺ Retrying [${id}] (${attempts}/${retry})...`);
                }
            }

            const durationMs = Date.now() - t0;
            clearLine();
            agentOutput(out);
            agentDone(role, durationMs);
            emit('agent_done', { agent: role, step: id, durationMs, outputLen: out.length });

            outputs[id] = out;
            vars[id] = { output: out };
            completed.add(id);
        }));
    }

    const finalOutput = outputs[steps[steps.length - 1]?.id] || '';
    emit('workflow_done', { workflow: name, completed: completed.size, skipped: skipped.size });
    success(`Workflow "${name}" — ${completed.size} done, ${skipped.size} skipped`);

    return { outputs, finalOutput };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const EXAMPLE_WORKFLOW = {
    name: 'feature-dev',
    autonomous: false,
    steps: [
        { id: 'research', role: 'Researcher', model: 'flash', task: 'Survey the codebase for context relevant to: {{input}}' },
        { id: 'plan',     role: 'Planner',    model: 'pro',   task: 'Create an implementation plan for: {{input}}', needs: ['research'] },
        { id: 'code',     role: 'Coder',      model: 'flash', task: 'Implement: {{input}}', needs: ['plan'] },
        { id: 'test',     role: 'Tester',     model: 'flash', task: 'Write tests for: {{input}}', needs: ['plan'] },
        { id: 'review',   role: 'Reviewer',   model: 'pro',   task: 'Review code and tests. Output APPROVED or NEEDS_WORK.', needs: ['code', 'test'] },
        { id: 'commit',   role: 'Git',        model: 'flash', task: 'Stage and commit the changes with a descriptive message.', needs: ['review'], condition: 'APPROVED', autonomous: true },
    ],
};

const [,, cmd, wfArg, inputArg] = process.argv;

if (cmd === 'example') {
    console.log(JSON.stringify(EXAMPLE_WORKFLOW, null, 2));
    process.exit(0);
}

if (cmd === 'run') {
    if (!wfArg) {
        console.error('  Usage: deepclaude workflow run <workflow.json> "<input>"');
        process.exit(1);
    }
    let wf;
    try { wf = JSON.parse(readFileSync(resolve(wfArg), 'utf8')); }
    catch (e) { console.error('  Error reading workflow:', e.message); process.exit(1); }

    const input = inputArg || wf.input || '';
    runWorkflow(wf, input).catch(e => { console.error(e.message); process.exit(1); });
} else {
    console.log(`
  deepclaude workflow — multi-agent DAG executor

  Commands:
    run <file.json> "<input>"   Execute a workflow
    example                     Print an example workflow JSON

  Workflow features:
    needs: [stepIds]            Dependency-based ordering + parallel execution
    condition: "APPROVED"       Skip step if keyword not in dependency output
    retry: 2                    Auto-retry on failure
    autonomous: true            Agents write files (--dangerously-skip-permissions)
    model: "pro"|"flash"|<id>   Per-step model selection
    {{input}} / {{stepId}}      Template variables in task strings
`);
}

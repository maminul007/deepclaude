/**
 * AUTOLOOP MODE
 *
 * Pattern from Enderfga/claw-orchestrator:
 *   Planner → Coder → Reviewer → [if not satisfied → Coder again] → ...
 *
 * Self-iterating loop: the reviewer decides whether to approve or request
 * another coding iteration. Convergence is guaranteed by MAX_ITERATIONS.
 *
 * All agents use pro model for quality; flash used for intermediate coders
 * in later iterations (cost optimisation as the loop progresses).
 */

import { runAgent, PRO_MODEL, FLASH_MODEL } from '../lib/runner.js';
import { agentHeader, agentOutput, agentDone, taskHeader, phaseHeader, success, error, thinking, clearLine } from '../lib/display.js';

const MAX_ITERATIONS = 5;

const PLANNER_SYSTEM = `You are a planning agent. Given a task:
1. State your understanding of the goal
2. Identify the key steps needed
3. Flag any ambiguities or assumptions
4. Be concise — this is a plan, not an implementation`;

const CODER_SYSTEM = (iteration, feedback) => `You are a senior developer on iteration ${iteration}.
${feedback ? `\nReviewer feedback from previous iteration:\n${feedback}\n\nAddress ALL feedback points.` : ''}

Write complete, working code. No placeholders. Follow existing patterns.`;

const REVIEWER_SYSTEM = `You are a critical reviewer. Evaluate the coder's output:
1. Does it correctly solve the original task?
2. Are there bugs, edge cases, or security issues?
3. Is the code complete (no missing pieces)?

Output ONE of:
- APPROVED — if the solution is correct and complete
- ITERATE: <specific actionable feedback> — if another coding pass is needed

Be decisive. Only request another iteration if genuinely necessary.`;

function parseReviewVerdict(output) {
    if (/^APPROVED/m.test(output)) return { done: true };
    const m = output.match(/^ITERATE:\s*(.+)/ms);
    if (m) return { done: false, feedback: m[1].trim() };
    return { done: true }; // default done if no clear signal
}

export async function runAutoloop(task) {
    taskHeader(task);

    // ── Plan ─────────────────────────────────────────────────────────────
    phaseHeader('Planning');
    agentHeader('Planner', PRO_MODEL);
    thinking('Planner');
    const planT0 = Date.now();

    const plan = await runAgent({
        role: 'Planner',
        model: PRO_MODEL,
        system: PLANNER_SYSTEM,
        task,
    });

    clearLine();
    agentOutput(plan);
    agentDone('Planner', Date.now() - planT0);

    let feedback = '';
    let lastCoderOutput = '';
    let iteration = 1;

    while (iteration <= MAX_ITERATIONS) {
        // ── Code ───────────────────────────────────────────────────────────
        // Use flash after first iteration (reviewer feedback narrows the task)
        const coderModel = iteration === 1 ? PRO_MODEL : FLASH_MODEL;
        phaseHeader(`Iteration ${iteration}/${MAX_ITERATIONS} — Coding`);
        agentHeader('Coder', coderModel);
        thinking('Coder');
        const codeT0 = Date.now();

        lastCoderOutput = await runAgent({
            role: 'Coder',
            model: coderModel,
            system: CODER_SYSTEM(iteration, feedback),
            context: iteration > 1 ? `### Previous code output\n${lastCoderOutput}` : `### Plan\n${plan}`,
            task,
        });

        clearLine();
        agentOutput(lastCoderOutput);
        agentDone('Coder', Date.now() - codeT0);

        // ── Review ─────────────────────────────────────────────────────────
        phaseHeader(`Iteration ${iteration}/${MAX_ITERATIONS} — Review`);
        agentHeader('Reviewer', PRO_MODEL);
        thinking('Reviewer');
        const revT0 = Date.now();

        const review = await runAgent({
            role: 'Reviewer',
            model: PRO_MODEL,
            system: REVIEWER_SYSTEM,
            context: `### Plan\n${plan}\n\n### Coder output (iteration ${iteration})\n${lastCoderOutput}`,
            task,
        });

        clearLine();
        agentOutput(review);
        agentDone('Reviewer', Date.now() - revT0);

        const verdict = parseReviewVerdict(review);

        if (verdict.done) {
            success(`Autoloop converged in ${iteration} iteration(s)`);
            return lastCoderOutput;
        }

        if (iteration === MAX_ITERATIONS) {
            error(`Max iterations (${MAX_ITERATIONS}) reached. Returning best effort.`);
            return lastCoderOutput;
        }

        feedback = verdict.feedback;
        console.log(`\n  → Requesting iteration ${iteration + 1}: ${feedback.substring(0, 100)}...\n`);
        iteration++;
    }

    return lastCoderOutput;
}

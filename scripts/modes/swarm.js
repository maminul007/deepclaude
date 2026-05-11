/**
 * SWARM MODE
 *
 * Pattern from affaan-m/claude-swarm:
 *   Planner (pro)  → breaks task into N subtasks
 *   Coders  (flash) → run ALL subtasks in parallel
 *   Reviewer (pro) → merges + validates, requests fixes if needed
 *
 * Pro model handles planning/review (complex reasoning).
 * Flash model handles execution (cheap, fast, parallel).
 * Max 3 fix cycles before escalating to user.
 */

import { runAgent, runParallel, PRO_MODEL, FLASH_MODEL } from '../lib/runner.js';
import { agentHeader, agentOutput, agentDone, taskHeader, phaseHeader, success, error, thinking, clearLine } from '../lib/display.js';

const MAX_FIX_CYCLES = 3;

const PLANNER_SYSTEM = `You are a software planning agent. Your job is to:
1. Analyse the user's task
2. Break it into 2-5 concrete, independent subtasks
3. Output ONLY a numbered list of subtasks, one per line, no extra text

Example output:
1. Read and understand the existing auth module in services/api/app/routers/auth.py
2. Add JWT refresh token endpoint to the auth router
3. Write unit tests for the new endpoint
4. Update the API documentation`;

const CODER_SYSTEM = (subtask, total, index) => `You are a senior software engineer (agent ${index} of ${total}).
Your ONLY job is to complete this specific subtask:

${subtask}

Rules:
- Be concrete and complete — write actual code, not descriptions
- If reading files is needed, include the file content in your output
- End your response with a clear RESULT section summarising what you did`;

const REVIEWER_SYSTEM = `You are a senior code reviewer. You receive the outputs of multiple coding agents and must:
1. Validate correctness and completeness
2. Identify any conflicts or gaps between agent outputs
3. Produce a unified, coherent final answer combining all outputs
4. If critical issues exist, output NEEDS_FIX: <specific instruction> on its own line
5. Otherwise output APPROVED on its own line at the end`;

function parseSubtasks(plannerOutput) {
    const lines = plannerOutput.split('\n');
    const subtasks = [];
    for (const line of lines) {
        const m = line.match(/^\s*\d+\.\s+(.+)/);
        if (m) subtasks.push(m[1].trim());
    }
    return subtasks.length ? subtasks : [plannerOutput.trim()];
}

function parseReviewerVerdict(reviewerOutput) {
    if (/^APPROVED/m.test(reviewerOutput)) return { approved: true };
    const fix = reviewerOutput.match(/^NEEDS_FIX:\s*(.+)/m);
    if (fix) return { approved: false, instruction: fix[1].trim() };
    return { approved: true }; // default approve if no explicit verdict
}

export async function runSwarm(task, sessionName) {
    taskHeader(task);

    // ── Phase 1: Plan ──────────────────────────────────────────────────────
    phaseHeader('Phase 1/3 — Planner (pro)');
    agentHeader('Planner', PRO_MODEL);
    thinking('Planner');
    const t0 = Date.now();

    const plan = await runAgent({
        role: 'Planner',
        model: PRO_MODEL,
        system: PLANNER_SYSTEM,
        task,
    });

    clearLine();
    agentOutput(plan);
    agentDone('Planner', Date.now() - t0);

    const subtasks = parseSubtasks(plan);
    console.log(`\n  → ${subtasks.length} subtask(s) identified\n`);

    // ── Phase 2: Parallel coding ───────────────────────────────────────────
    phaseHeader(`Phase 2/3 — Coders ×${subtasks.length} (flash, parallel)`);

    const coderConfigs = subtasks.map((subtask, i) => ({
        role: `Coder`,
        model: FLASH_MODEL,
        system: CODER_SYSTEM(subtask, subtasks.length, i + 1),
        task,
        onToken: null,
    }));

    // Show headers before starting
    subtasks.forEach((_, i) => agentHeader('Coder', FLASH_MODEL, i + 1, subtasks.length));
    thinking('All coders');

    const coderT0 = Date.now();
    const coderOutputs = await runParallel(coderConfigs);
    clearLine();

    coderOutputs.forEach((output, i) => {
        agentHeader('Coder', FLASH_MODEL, i + 1, subtasks.length);
        agentOutput(output);
        agentDone(`Coder ${i + 1}`, Date.now() - coderT0);
    });

    let combinedContext = coderOutputs.map((o, i) =>
        `### Coder ${i + 1} — Subtask: ${subtasks[i]}\n${o}`
    ).join('\n\n');

    // ── Phase 3: Review + fix loop ─────────────────────────────────────────
    for (let cycle = 1; cycle <= MAX_FIX_CYCLES; cycle++) {
        phaseHeader(`Phase 3/${MAX_FIX_CYCLES} — Reviewer (pro) — cycle ${cycle}`);
        agentHeader('Reviewer', PRO_MODEL);
        thinking('Reviewer');
        const rT0 = Date.now();

        const review = await runAgent({
            role: 'Reviewer',
            model: PRO_MODEL,
            system: REVIEWER_SYSTEM,
            context: combinedContext,
            task,
        });

        clearLine();
        agentOutput(review);
        agentDone('Reviewer', Date.now() - rT0);

        const verdict = parseReviewerVerdict(review);

        if (verdict.approved) {
            success(`Swarm complete — ${subtasks.length} agents, ${cycle} review cycle(s)`);
            return review;
        }

        if (cycle === MAX_FIX_CYCLES) {
            error(`Max fix cycles (${MAX_FIX_CYCLES}) reached. Returning best effort.`);
            return review;
        }

        // Fix cycle — re-run coders with reviewer instruction as extra context
        console.log(`\n  → Fix requested: ${verdict.instruction}\n`);
        const fixContext = `${combinedContext}\n\n### Reviewer Fix Request\n${verdict.instruction}`;
        thinking('Fix coders');
        const fixOutputs = await runParallel(coderConfigs.map(cfg => ({
            ...cfg,
            context: fixContext,
        })));
        clearLine();
        combinedContext = fixOutputs.map((o, i) =>
            `### Coder ${i + 1} fix — Subtask: ${subtasks[i]}\n${o}`
        ).join('\n\n');
    }
}

/**
 * PIPELINE MODE
 *
 * Pattern from aaddrick/claude-pipeline:
 *   Researcher → Architect → Coder → Tester → Reviewer
 *
 * Each agent receives ALL previous agents' outputs as context.
 * Agents can be skipped if the task doesn't require them (auto-detected).
 * Model tier: pro for Researcher/Architect/Reviewer, flash for Coder/Tester.
 */

import { runAgent, PRO_MODEL, FLASH_MODEL } from '../lib/runner.js';
import { agentHeader, agentOutput, agentDone, taskHeader, phaseHeader, success, thinking, clearLine } from '../lib/display.js';

const AGENTS = [
    {
        role: 'Researcher',
        model: PRO_MODEL,
        system: `You are a research agent. Analyse the codebase and task to:
1. Identify relevant existing files, functions, and patterns
2. Note any constraints, dependencies, or risks
3. Summarise your findings concisely — the next agents depend on this`,
    },
    {
        role: 'Architect',
        model: PRO_MODEL,
        system: `You are a software architect. Based on the researcher's findings:
1. Design the solution structure (files to create/modify, functions, data flow)
2. Define interfaces and contracts between components
3. Flag any architectural risks or trade-offs
Do NOT write implementation code — only design.`,
    },
    {
        role: 'Coder',
        model: FLASH_MODEL,
        system: `You are a senior developer. Implement the architect's design:
1. Write complete, working code — no placeholders or TODOs
2. Follow existing code style and patterns from the researcher's findings
3. Include all necessary imports and exports`,
    },
    {
        role: 'Tester',
        model: FLASH_MODEL,
        system: `You are a QA engineer. Write tests for the coder's implementation:
1. Unit tests for all new functions
2. Edge cases and error conditions
3. Use the same test framework already in the project`,
    },
    {
        role: 'Reviewer',
        model: PRO_MODEL,
        system: `You are a principal engineer doing final review:
1. Validate the implementation matches the architecture
2. Check for security issues, edge cases, performance problems
3. Suggest any critical fixes
4. Output a final SUMMARY section with the complete solution`,
    },
];

/**
 * Detect which agents are needed based on task keywords.
 * Always runs Coder and Reviewer. Researcher/Architect/Tester are optional.
 */
function selectAgents(task) {
    const t = task.toLowerCase();
    const needsResearch  = /read|understand|exist|find|check|analys|look/.test(t);
    const needsArchitect = /design|architect|structure|new feature|implement|refactor|integrat/.test(t);
    const needsTester    = /test|spec|coverage|tdd|unit|assert/.test(t);

    return AGENTS.filter(a => {
        if (a.role === 'Researcher') return needsResearch || needsArchitect;
        if (a.role === 'Architect')  return needsArchitect;
        if (a.role === 'Tester')     return needsTester;
        return true; // Coder + Reviewer always run
    });
}

export async function runPipeline(task) {
    taskHeader(task);

    const agents = selectAgents(task);
    console.log(`  → Running ${agents.length} agents: ${agents.map(a => a.role).join(' → ')}\n`);

    const outputs = {};
    const results = [];

    for (let i = 0; i < agents.length; i++) {
        const agent = agents[i];
        phaseHeader(`Step ${i + 1}/${agents.length} — ${agent.role}`);
        agentHeader(agent.role, agent.model, i + 1, agents.length);

        // Build context from all previous agents
        const context = results.length
            ? results.map(r => `### ${r.role}\n${r.output}`).join('\n\n')
            : '';

        thinking(agent.role);
        const t0 = Date.now();

        const output = await runAgent({
            role: agent.role,
            model: agent.model,
            system: agent.system,
            context,
            task,
        });

        clearLine();
        agentOutput(output);
        agentDone(agent.role, Date.now() - t0);

        outputs[agent.role] = output;
        results.push({ role: agent.role, output });
    }

    success(`Pipeline complete — ${agents.length} agents finished`);

    // Return the reviewer's final output (or coder's if no reviewer ran)
    return outputs['Reviewer'] || outputs['Coder'] || results[results.length - 1].output;
}

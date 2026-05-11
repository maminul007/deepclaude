#!/usr/bin/env node
/**
 * clawbot — multi-agent orchestration REPL for deepclaude
 *
 * Three modes, all routed through deepclaude's model proxy:
 *
 *   swarm     Planner(pro) → Coders×N(flash, parallel) → Reviewer(pro)
 *             Best for: large tasks with independent subtasks
 *
 *   pipeline  Researcher → Architect → Coder → Tester → Reviewer
 *             Best for: feature development with full lifecycle
 *
 *   autoloop  Planner → Coder → Reviewer → [iterate] → Approved
 *             Best for: code generation with quality gate
 *
 * Usage:
 *   node scripts/claw.js [--mode swarm|pipeline|autoloop]
 *   deepclaude --claw [--mode swarm]
 *   CLAW_SESSION=trading npm run claw
 *
 * REPL commands:
 *   /mode <swarm|pipeline|autoloop>   Switch mode
 *   /clear                            Clear session history
 *   /history                          Print session history
 *   /sessions                         List all sessions
 *   /status                           Show current config
 *   /help                             Show commands
 *   exit                              Quit
 */

import { createInterface } from 'readline';
import { banner, error, success } from './lib/display.js';
import { loadHistory, appendTurn, clearSession, listSessions, saveNote, recentHistory, persistentNotes, buildMemoryContext } from './lib/session.js';
import { runSwarm } from './modes/swarm.js';
import { runPipeline } from './modes/pipeline.js';
import { runAutoloop } from './modes/autoloop.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SESSION_NAME = (process.env.CLAW_SESSION || 'default').replace(/[^a-zA-Z0-9-]/g, '-');
const BACKEND      = process.env.ANTHROPIC_BASE_URL || 'claude (direct)';

// Parse --mode flag
let MODE = process.env.CLAW_MODE || 'swarm';
const modeArg = process.argv.indexOf('--mode');
if (modeArg !== -1 && process.argv[modeArg + 1]) {
    MODE = process.argv[modeArg + 1];
}

const VALID_MODES = ['swarm', 'pipeline', 'autoloop'];

// ---------------------------------------------------------------------------
// REPL commands
// ---------------------------------------------------------------------------

function showHelp() {
    console.log(`
  clawbot commands:
    /mode <swarm|pipeline|autoloop>   Switch active mode
    /clear                            Clear session history
    /history                          Print full session history
    /memory                           Show all memory context (history + notes + codebase)
    /note <text>                      Save a persistent note for this session
    /sessions                         List all saved sessions
    /status                           Show current config
    /help                             Show this help
    exit / quit                       Exit

  Modes:
    swarm     — parallel agents (Planner + Coders×N + Reviewer)
    pipeline  — sequential agents (Researcher→Architect→Coder→Tester→Reviewer)
    autoloop  — iterating loop (Planner→Coder→Reviewer→repeat until approved)

  Memory layers (injected into first agent of every run):
    1. Session history  — last 10 turns from this session
    2. Persistent notes — /note entries saved across sessions
    3. Codebase snapshot — git branch, recent commits, file tree
`);
}

function showStatus(mode) {
    console.log(`
  Status:
    Session : ${SESSION_NAME}
    Mode    : ${mode}
    Backend : ${BACKEND}
    AutoRoute: ${process.env.AUTO_ROUTE === '1' ? 'enabled' : 'disabled'}
`);
}

// ---------------------------------------------------------------------------
// Main REPL
// ---------------------------------------------------------------------------

async function main() {
    let currentMode = VALID_MODES.includes(MODE) ? MODE : 'swarm';
    banner(currentMode, SESSION_NAME, BACKEND);

    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    let rlClosed = false;
    let busy = false;
    rl.on('close', () => { rlClosed = true; if (!busy) process.exit(0); });

    function prompt() {
        if (rlClosed) { process.exit(0); return; }
        rl.question(`\nclaw(${SESSION_NAME}:${currentMode})> `, async (input) => {
            input = input.trim();

            if (!input) { prompt(); return; }

            // Exit
            if (input === 'exit' || input === 'quit') {
                console.log('  Bye.');
                rl.close();
                process.exit(0);
            }

            // /mode switch
            if (input.startsWith('/mode')) {
                const parts = input.split(/\s+/);
                const newMode = parts[1];
                if (!newMode) {
                    console.log(`  Current mode: ${currentMode}. Available: ${VALID_MODES.join(', ')}`);
                } else if (!VALID_MODES.includes(newMode)) {
                    error(`Unknown mode '${newMode}'. Use: ${VALID_MODES.join(', ')}`);
                } else {
                    currentMode = newMode;
                    success(`Switched to ${currentMode} mode`);
                }
                prompt();
                return;
            }

            // /clear
            if (input === '/clear') {
                clearSession(SESSION_NAME);
                console.log(`  Session '${SESSION_NAME}' cleared.\n`);
                prompt();
                return;
            }

            // /history
            if (input === '/history') {
                const h = loadHistory(SESSION_NAME);
                console.log(h.trim() || '  (empty)');
                prompt();
                return;
            }

            // /memory
            if (input === '/memory') {
                const mem = buildMemoryContext(SESSION_NAME);
                console.log(mem.trim() || '  (no memory yet)');
                prompt();
                return;
            }

            // /note <text>
            if (input.startsWith('/note ')) {
                const note = input.slice(6).trim();
                if (!note) { error('Usage: /note <text>'); prompt(); return; }
                saveNote(SESSION_NAME, note);
                success(`Note saved to session '${SESSION_NAME}'`);
                prompt();
                return;
            }

            // /sessions
            if (input === '/sessions') {
                const sessions = listSessions();
                console.log('  Saved sessions:');
                for (const s of sessions) {
                    console.log(`    ${s}${s === SESSION_NAME ? ' ← active' : ''}`);
                }
                console.log('');
                prompt();
                return;
            }

            // /status
            if (input === '/status') {
                showStatus(currentMode);
                prompt();
                return;
            }

            // /help
            if (input === '/help') {
                showHelp();
                prompt();
                return;
            }

            // Unknown command
            if (input.startsWith('/')) {
                error(`Unknown command '${input}'. Type /help for commands.`);
                prompt();
                return;
            }

            // ── Run the task ───────────────────────────────────────────────
            appendTurn(SESSION_NAME, 'User', input);

            busy = true;
            let result;
            try {
                switch (currentMode) {
                    case 'swarm':
                        result = await runSwarm(input, SESSION_NAME);
                        break;
                    case 'pipeline':
                        result = await runPipeline(input, SESSION_NAME);
                        break;
                    case 'autoloop':
                        result = await runAutoloop(input, SESSION_NAME);
                        break;
                }
                if (result) appendTurn(SESSION_NAME, `Assistant (${currentMode})`, result);
            } catch (err) {
                error(err.message);
            } finally {
                busy = false;
                if (rlClosed) { process.exit(0); return; }
            }

            prompt();
        });
    }

    prompt();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});

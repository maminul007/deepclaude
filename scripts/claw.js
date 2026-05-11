#!/usr/bin/env node
/**
 * claw — persistent AI agent REPL for deepclaude
 *
 * Conversation history is saved to ~/.claude/claw/<session>.md so sessions
 * survive restarts. Requests go through deepclaude's model proxy when the
 * ANTHROPIC_BASE_URL env var is set (i.e. when launched inside deepclaude).
 *
 * Usage:
 *   node scripts/claw.js
 *   CLAW_SESSION=my-project node scripts/claw.js
 *   CLAW_SKILLS=tdd-workflow,security-review node scripts/claw.js
 *
 * REPL commands:
 *   /clear      Clear current session history
 *   /history    Print full conversation history
 *   /sessions   List all saved sessions
 *   /help       Show available commands
 *   exit        Quit
 */

import { spawnSync, execSync } from 'child_process';
import { createInterface } from 'readline';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SESSION_NAME = (process.env.CLAW_SESSION || 'default').replace(/[^a-zA-Z0-9-]/g, '-');
const SKILLS_RAW   = process.env.CLAW_SKILLS || '';
const SESSION_DIR  = join(homedir(), '.claude', 'claw');
const SESSION_FILE = join(SESSION_DIR, `${SESSION_NAME}.md`);

// ---------------------------------------------------------------------------
// Session storage helpers
// ---------------------------------------------------------------------------

function ensureDir() {
    if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
}

function loadHistory() {
    if (!existsSync(SESSION_FILE)) return '';
    return readFileSync(SESSION_FILE, 'utf8');
}

function appendTurn(role, content) {
    ensureDir();
    const ts = new Date().toISOString();
    const entry = `### [${ts}] ${role}\n${content}\n---\n`;
    writeFileSync(SESSION_FILE, loadHistory() + entry, 'utf8');
}

function clearSession() {
    ensureDir();
    writeFileSync(SESSION_FILE, '', 'utf8');
}

function listSessions() {
    ensureDir();
    return readdirSync(SESSION_DIR)
        .filter(f => f.endsWith('.md'))
        .map(f => f.replace('.md', ''));
}

// ---------------------------------------------------------------------------
// Skill context loader
// ---------------------------------------------------------------------------

function loadSkillContext() {
    if (!SKILLS_RAW.trim()) return '';
    const skills = SKILLS_RAW.split(',').map(s => s.trim()).filter(Boolean);
    const parts = [];
    for (const skill of skills) {
        // Look for skill files in common locations
        const candidates = [
            join(homedir(), '.claude', 'skills', skill, 'SKILL.md'),
            join(homedir(), '.claude', 'skills', `${skill}.md`),
        ];
        for (const p of candidates) {
            if (existsSync(p)) {
                parts.push(`## Skill: ${skill}\n${readFileSync(p, 'utf8')}`);
                break;
            }
        }
    }
    return parts.length ? `\n\n---\n# Loaded Skills\n${parts.join('\n\n')}` : '';
}

// ---------------------------------------------------------------------------
// Claude invocation
// ---------------------------------------------------------------------------

/**
 * Build the prompt string from session history + new user message.
 * History is prepended so claude -p has full context.
 */
function buildPrompt(history, userMessage, skillContext) {
    const sections = [];
    if (skillContext) sections.push(skillContext.trim());
    if (history.trim()) sections.push(`# Conversation History\n${history.trim()}`);
    sections.push(`# Current Message\n${userMessage}`);
    return sections.join('\n\n');
}

/**
 * Call claude -p with the full prompt, return stdout as string.
 * Inherits ANTHROPIC_BASE_URL etc. from environment — so deepclaude
 * proxy routing happens transparently.
 */
function runClaude(prompt) {
    const result = spawnSync('claude', ['-p', prompt], {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        env: process.env,
    });

    if (result.error) {
        throw new Error(`Failed to run claude: ${result.error.message}`);
    }
    if (result.status !== 0) {
        const errMsg = (result.stderr || '').trim();
        throw new Error(`claude exited ${result.status}: ${errMsg || '(no stderr)'}`);
    }
    return (result.stdout || '').trim();
}

// ---------------------------------------------------------------------------
// REPL commands
// ---------------------------------------------------------------------------

const COMMANDS = {
    '/clear': (rl) => {
        clearSession();
        console.log(`  Session '${SESSION_NAME}' cleared.\n`);
    },
    '/history': () => {
        const h = loadHistory();
        console.log(h.trim() || '  (empty)');
        console.log('');
    },
    '/sessions': () => {
        const sessions = listSessions();
        console.log('  Saved sessions:');
        for (const s of sessions) {
            const active = s === SESSION_NAME ? ' ← active' : '';
            console.log(`    ${s}${active}`);
        }
        console.log('');
    },
    '/help': () => {
        console.log(`
  Claw commands:
    /clear      Clear current session history
    /history    Print full conversation history
    /sessions   List all saved sessions
    /help       Show this help
    exit        Quit
`);
    },
};

// ---------------------------------------------------------------------------
// Main REPL
// ---------------------------------------------------------------------------

function printBanner() {
    const backend = process.env.ANTHROPIC_BASE_URL
        ? `proxy → ${process.env.ANTHROPIC_BASE_URL}`
        : 'claude (direct)';
    const autoRoute = process.env.AUTO_ROUTE === '1' || process.env.AUTO_ROUTE === 'true'
        ? ' + auto-routing'
        : '';

    console.log(`
  ╔═══════════════════════════════════╗
  ║   claw — deepclaude agent REPL   ║
  ╚═══════════════════════════════════╝
  Session : ${SESSION_NAME}
  Backend : ${backend}${autoRoute}
  History : ${SESSION_FILE}
  Skills  : ${SKILLS_RAW || 'none'}

  Type /help for commands, exit to quit.
`);
}

async function main() {
    printBanner();

    const skillContext = loadSkillContext();
    if (skillContext) {
        console.log(`  Loaded skills: ${SKILLS_RAW}\n`);
    }

    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `claw(${SESSION_NAME})> `,
    });

    rl.prompt();

    rl.on('line', async (line) => {
        const input = line.trim();

        if (!input) { rl.prompt(); return; }

        if (input === 'exit' || input === 'quit') {
            console.log('  Bye.');
            rl.close();
            process.exit(0);
        }

        if (COMMANDS[input]) {
            COMMANDS[input](rl);
            rl.prompt();
            return;
        }

        // Regular message — call claude
        appendTurn('User', input);
        const history = loadHistory();

        process.stdout.write('  thinking...');

        let response;
        try {
            const prompt = buildPrompt(
                // Strip the last User turn we just appended so history isn't duplicated in prompt
                history.slice(0, history.lastIndexOf(`### `)),
                input,
                skillContext,
            );
            response = runClaude(prompt);
        } catch (err) {
            process.stdout.write('\r' + ' '.repeat(20) + '\r');
            console.error(`  Error: ${err.message}\n`);
            rl.prompt();
            return;
        }

        process.stdout.write('\r' + ' '.repeat(20) + '\r');
        console.log(`\n${response}\n`);

        appendTurn('Assistant', response);
        rl.prompt();
    });

    rl.on('close', () => {
        process.exit(0);
    });
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});

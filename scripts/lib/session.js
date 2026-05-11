/**
 * Session persistence + memory context for clawbot.
 *
 * Three memory layers:
 *   1. Session history  — ~/.claude/claw/<session>.md  (per-session turns)
 *   2. Codebase context — live git + file snapshot      (injected each run)
 *   3. Persistent notes — ~/.claude/claw/<session>.notes.md (manual saves)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

const SESSION_DIR = join(homedir(), '.claude', 'claw');
const MAX_HISTORY_TURNS = 10;     // cap how many prior turns to inject
const MAX_HISTORY_CHARS = 6000;   // cap total history chars to avoid blowing context

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

export function sessionFile(name) {
    return join(SESSION_DIR, `${name}.md`);
}

export function notesFile(name) {
    return join(SESSION_DIR, `${name}.notes.md`);
}

export function ensureDir() {
    if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
}

export function loadHistory(name) {
    const file = sessionFile(name);
    if (!existsSync(file)) return '';
    return readFileSync(file, 'utf8');
}

export function loadNotes(name) {
    const file = notesFile(name);
    if (!existsSync(file)) return '';
    return readFileSync(file, 'utf8');
}

export function appendTurn(name, role, content) {
    ensureDir();
    const ts = new Date().toISOString();
    const entry = `### [${ts}] ${role}\n${content.trim()}\n---\n`;
    writeFileSync(sessionFile(name), loadHistory(name) + entry, 'utf8');
}

export function saveNote(name, note) {
    ensureDir();
    const ts = new Date().toISOString();
    const existing = loadNotes(name);
    writeFileSync(notesFile(name), `${existing}### [${ts}]\n${note.trim()}\n---\n`, 'utf8');
}

export function clearSession(name) {
    ensureDir();
    writeFileSync(sessionFile(name), '', 'utf8');
}

export function listSessions() {
    ensureDir();
    return readdirSync(SESSION_DIR)
        .filter(f => f.endsWith('.md') && !f.endsWith('.notes.md'))
        .map(f => f.replace('.md', ''));
}

// ---------------------------------------------------------------------------
// Layer 1: Recent session history (last N turns, capped by chars)
// ---------------------------------------------------------------------------

/**
 * Returns the last MAX_HISTORY_TURNS turns, truncated to MAX_HISTORY_CHARS.
 * Oldest turns are dropped first when over the char limit.
 */
export function recentHistory(name) {
    const raw = loadHistory(name).trim();
    if (!raw) return '';

    const turns = raw.split('---\n').filter(t => t.trim());
    const recent = turns.slice(-MAX_HISTORY_TURNS);

    let combined = recent.join('---\n');
    if (combined.length > MAX_HISTORY_CHARS) {
        combined = '...[earlier turns truncated]...\n' +
            combined.slice(combined.length - MAX_HISTORY_CHARS);
    }
    return combined;
}

// ---------------------------------------------------------------------------
// Layer 2: Live codebase context — uses spawnSync (no shell, safe)
// ---------------------------------------------------------------------------

/**
 * Run a command safely with no shell interpolation.
 * All args are passed as an array — no injection risk.
 */
function safeRun(cmd, args, cwd = process.cwd()) {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return (r.stdout || '').trim();
}

/**
 * Builds a compact codebase snapshot:
 *   - current git branch + last 5 commits
 *   - staged/unstaged file list
 *   - top-level directory tree (2 levels, node_modules/.git excluded)
 */
export function codbaseContext(cwd = process.cwd()) {
    const branch = safeRun('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    const log    = safeRun('git', ['log', '--oneline', '-5'], cwd);
    const status = safeRun('git', ['status', '--short'], cwd);
    const tree   = safeRun('find', [
        '.', '-maxdepth', '2',
        '-not', '-path', '*/node_modules/*',
        '-not', '-path', '*/.git/*',
        '-not', '-path', '*/.claude-flow/*',
    ], cwd);

    const parts = [];
    if (branch) parts.push(`**Branch:** ${branch}`);
    if (log)    parts.push(`**Recent commits:**\n${log}`);
    if (status) parts.push(`**Changed files:**\n${status}`);
    if (tree)   parts.push(`**Project tree:**\n${tree.split('\n').slice(0, 60).join('\n')}`);

    return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Layer 3: Persistent notes (user-saved facts about the project)
// ---------------------------------------------------------------------------

export function persistentNotes(name) {
    return loadNotes(name);
}

// ---------------------------------------------------------------------------
// Compose full memory context for injection into first agent
// ---------------------------------------------------------------------------

/**
 * Returns a formatted memory block ready to inject as `context` into
 * the first agent (Planner / Researcher / Coder depending on mode).
 *
 * @param {string} sessionName
 * @param {boolean} includeCodebase  whether to include git/file snapshot
 */
export function buildMemoryContext(sessionName, includeCodebase = true) {
    const sections = [];

    const history = recentHistory(sessionName);
    if (history) {
        sections.push(`## Conversation History (this session)\n${history}`);
    }

    const notes = persistentNotes(sessionName);
    if (notes) {
        sections.push(`## Persistent Notes\n${notes}`);
    }

    if (includeCodebase) {
        const codebase = codbaseContext();
        if (codebase) {
            sections.push(`## Codebase Snapshot\n${codebase}`);
        }
    }

    return sections.join('\n\n---\n\n');
}

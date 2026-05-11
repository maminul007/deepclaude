/**
 * Session persistence for clawbot.
 * Stores conversation turns in ~/.claude/claw/<session>.md
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const SESSION_DIR = join(homedir(), '.claude', 'claw');

export function sessionFile(name) {
    return join(SESSION_DIR, `${name}.md`);
}

export function ensureDir() {
    if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
}

export function loadHistory(name) {
    const file = sessionFile(name);
    if (!existsSync(file)) return '';
    return readFileSync(file, 'utf8');
}

export function appendTurn(name, role, content) {
    ensureDir();
    const ts = new Date().toISOString();
    const entry = `### [${ts}] ${role}\n${content.trim()}\n---\n`;
    writeFileSync(sessionFile(name), loadHistory(name) + entry, 'utf8');
}

export function clearSession(name) {
    ensureDir();
    writeFileSync(sessionFile(name), '', 'utf8');
}

export function listSessions() {
    ensureDir();
    return readdirSync(SESSION_DIR)
        .filter(f => f.endsWith('.md'))
        .map(f => f.replace('.md', ''));
}

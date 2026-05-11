#!/usr/bin/env node
/**
 * deepclaude watch — file-change triggered autonomous agent
 *
 * Watches a directory for source file changes. When a file is saved:
 *   - Source file (.js/.ts/.py/.go etc.) → pipeline (Coder → Reviewer)
 *   - Test file (*test*, *spec*)          → pipeline (Tester → Reviewer)
 *
 * Agents run with --dangerously-skip-permissions so they can actually
 * edit the file they're reviewing (self-healing mode).
 *
 * Usage:
 *   node scripts/watch.js [dir]     Watch <dir> (default: cwd)
 *   deepclaude watch [dir]
 */

import { watch } from 'fs';
import { resolve, relative, extname, basename } from 'path';
import { runAgent, PRO_MODEL, FLASH_MODEL } from './lib/runner.js';
import { agentHeader, agentOutput, agentDone, thinking, clearLine } from './lib/display.js';

const SOURCE_EXTS = new Set(['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java', '.rb', '.cs']);
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.next', 'coverage']);

const targetDir = resolve(process.argv[2] || process.cwd());

// ---------------------------------------------------------------------------
// Debounce: collect rapid saves (e.g. format-on-save), wait 1.5s before acting
// ---------------------------------------------------------------------------

const pending = new Map(); // filepath → timer

function scheduleRun(filepath) {
    if (pending.has(filepath)) clearTimeout(pending.get(filepath));
    pending.set(filepath, setTimeout(() => {
        pending.delete(filepath);
        triggerAgents(filepath).catch(e => console.error('  Agent error:', e.message));
    }, 1500));
}

// ---------------------------------------------------------------------------
// Classify file → task prompt
// ---------------------------------------------------------------------------

function classifyFile(filepath) {
    const name = basename(filepath).toLowerCase();
    const ext  = extname(filepath);

    if (!SOURCE_EXTS.has(ext)) return null;

    const isTest = name.includes('test') || name.includes('spec');

    if (isTest) {
        return {
            type: 'test',
            task: `Review and fix the failing or incomplete tests in: ${filepath}
Look at the test file, understand what it's testing, and make the tests correct and complete.
Fix any broken assertions. Do not delete tests — fix them.`,
        };
    }

    return {
        type: 'source',
        task: `Review the recently changed source file: ${filepath}
1. Check for bugs, edge cases, and obvious errors
2. If you find issues, fix them directly in the file
3. Ensure the code follows existing patterns in the project
4. If nothing is wrong, output: LGTM — no changes needed`,
    };
}

// ---------------------------------------------------------------------------
// Run agents on a changed file
// ---------------------------------------------------------------------------

async function triggerAgents(filepath) {
    const rel = relative(targetDir, filepath);
    const classified = classifyFile(filepath);
    if (!classified) return;

    console.log(`\n  [watch] Changed: ${rel}`);
    console.log(`  [watch] Running ${classified.type === 'test' ? 'test' : 'review'} agents...\n`);

    const t0 = Date.now();

    // Coder/Tester agent — autonomous, can write files
    agentHeader('Reviewer', FLASH_MODEL);
    thinking('Reviewer');
    const reviewT0 = Date.now();

    const review = await runAgent({
        role: 'Reviewer',
        model: FLASH_MODEL,
        autonomous: true,
        cwd: targetDir,
        task: classified.task,
        onToken: (t) => process.stdout.write(t),
    });

    clearLine();
    agentDone('Reviewer', Date.now() - reviewT0);

    // If reviewer made changes, run a final quality check
    if (!review.includes('LGTM') && !review.includes('no changes needed')) {
        agentHeader('QA', PRO_MODEL);
        thinking('QA');
        const qaT0 = Date.now();

        const qa = await runAgent({
            role: 'QA',
            model: PRO_MODEL,
            autonomous: true,
            cwd: targetDir,
            context: `Reviewer output:\n${review}`,
            task: `Verify the changes made to ${filepath} are correct and didn't introduce new issues.
If everything looks good, output: APPROVED. If there's still a problem, fix it.`,
            onToken: (t) => process.stdout.write(t),
        });

        clearLine();
        agentDone('QA', Date.now() - qaT0);
    }

    console.log(`\n  [watch] Cycle done in ${((Date.now() - t0) / 1000).toFixed(1)}s — watching for changes...\n`);
}

// ---------------------------------------------------------------------------
// Recursive watcher
// ---------------------------------------------------------------------------

function shouldIgnore(name) {
    return IGNORE_DIRS.has(name) || name.startsWith('.');
}

function watchDir(dir) {
    try {
        const watcher = watch(dir, { recursive: false }, (event, filename) => {
            if (!filename || shouldIgnore(filename)) return;
            const full = resolve(dir, filename);
            scheduleRun(full);
        });
        watcher.on('error', () => {}); // ignore watch errors on deleted dirs
    } catch {}
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

console.log(`\n  [watch] Watching: ${targetDir}`);
console.log('  [watch] Agents run autonomously on every save. Ctrl+C to stop.\n');

// Watch top-level + one level deep (covers src/, lib/, etc.)
watchDir(targetDir);
try {
    const { readdirSync, statSync } = await import('fs');
    for (const entry of readdirSync(targetDir)) {
        if (shouldIgnore(entry)) continue;
        try {
            const full = resolve(targetDir, entry);
            if (statSync(full).isDirectory()) watchDir(full);
        } catch {}
    }
} catch {}

// Keep process alive
process.stdin.resume();
process.on('SIGINT', () => { console.log('\n  [watch] Stopped.'); process.exit(0); });

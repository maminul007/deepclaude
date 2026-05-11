#!/usr/bin/env node
/**
 * cadence daemon — background task queue processor
 *
 * Drop a JSON file into ~/.claude/claw/queue/ and the daemon runs it.
 * Task file format: { task, mode, session, cwd }
 *
 * Usage:
 *   node scripts/daemon.js start    # fork into background
 *   node scripts/daemon.js stop     # kill running daemon
 *   node scripts/daemon.js status   # is it running?
 *   node scripts/daemon.js run      # run in foreground (for debugging)
 *
 * Task file lifecycle:
 *   <id>.task  →  <id>.task.running  →  <id>.task.done | <id>.task.failed
 */

import { existsSync, mkdirSync, readdirSync, renameSync, readFileSync, writeFileSync } from 'fs';
import { watch } from 'fs';
import { emit } from './lib/events.js';
import { join } from 'path';
import { homedir } from 'os';
import { spawnSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const QUEUE_DIR  = join(homedir(), '.claude', 'claw', 'queue');
const PID_FILE   = join(homedir(), '.claude', 'claw', 'daemon.pid');
const LOG_FILE   = join(homedir(), '.claude', 'claw', 'daemon.log');
const RESULT_DIR = join(homedir(), '.claude', 'claw', 'results');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    process.stdout.write(line);
    try { writeFileSync(LOG_FILE, line, { flag: 'a' }); } catch {}
}

function ensureDirs() {
    for (const d of [QUEUE_DIR, RESULT_DIR, join(homedir(), '.claude', 'claw')]) {
        mkdirSync(d, { recursive: true });
    }
}

function isRunning(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPid() {
    try { return parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Task execution
// ---------------------------------------------------------------------------

async function processTask(taskFile) {
    const runningFile = taskFile + '.running';
    renameSync(taskFile, runningFile);

    let payload;
    try {
        payload = JSON.parse(readFileSync(runningFile, 'utf8'));
    } catch (e) {
        log(`Bad task file: ${e.message}`);
        renameSync(runningFile, taskFile + '.failed');
        return;
    }

    const { task, mode = 'pipeline', session = 'daemon', cwd = process.cwd() } = payload;
    log(`Running [${mode}] "${task.substring(0, 80)}" in ${cwd}`);
    emit('daemon_pickup', { task, mode, session, cwd });

    const { runSwarm }    = await import('./modes/swarm.js');
    const { runPipeline } = await import('./modes/pipeline.js');
    const { runAutoloop } = await import('./modes/autoloop.js');

    const runners = { swarm: runSwarm, pipeline: runPipeline, autoloop: runAutoloop };
    const runner  = runners[mode] || runPipeline;

    const t0 = Date.now();
    const originalCwd = process.cwd();
    try {
        process.chdir(cwd);
        const result = await runner(task, session);
        process.chdir(originalCwd);

        const resultFile = join(RESULT_DIR, `${Date.now()}.result.json`);
        writeFileSync(resultFile, JSON.stringify({ task, mode, session, cwd, result, ts: new Date().toISOString() }, null, 2));
        renameSync(runningFile, taskFile + '.done');
        emit('task_done', { task, mode, durationMs: Date.now() - t0 });
        log(`Done → ${resultFile}`);
    } catch (e) {
        process.chdir(originalCwd);
        emit('agent_error', { task, mode, error: e.message });
        writeFileSync(taskFile + '.failed', JSON.stringify({ task, error: e.message, ts: new Date().toISOString() }, null, 2));
        try { renameSync(runningFile, taskFile + '.failed.json'); } catch {}
        log(`Failed: ${e.message}`);
    }
}

// ---------------------------------------------------------------------------
// Daemon loop
// ---------------------------------------------------------------------------

let busy = false;

async function tick() {
    if (busy) return;
    let files;
    try { files = readdirSync(QUEUE_DIR).filter(f => f.endsWith('.task')); }
    catch { return; }

    if (!files.length) return;
    busy = true;
    try {
        await processTask(join(QUEUE_DIR, files[0]));
    } finally {
        busy = false;
    }
}

function runLoop() {
    ensureDirs();
    log('Daemon started (pid ' + process.pid + ')');
    writeFileSync(PID_FILE, String(process.pid));

    // Watch for new files + poll every 2s as fallback
    watch(QUEUE_DIR, () => tick());
    setInterval(tick, 2000);
    tick(); // drain any existing queue immediately
}

// ---------------------------------------------------------------------------
// CLI commands
// ---------------------------------------------------------------------------

const [,, cmd] = process.argv;

switch (cmd) {
    case 'start': {
        const pid = readPid();
        if (pid && isRunning(pid)) { console.log(`  Daemon already running (pid ${pid})`); process.exit(0); }
        ensureDirs();
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run'], {
            detached: true, stdio: 'ignore',
            env: { ...process.env },
        });
        child.unref();
        // Give it a moment to write PID
        await new Promise(r => setTimeout(r, 400));
        const newPid = readPid();
        console.log(`  Daemon started (pid ${newPid || child.pid})`);
        console.log(`  Queue : ${QUEUE_DIR}`);
        console.log(`  Results: ${RESULT_DIR}`);
        console.log(`  Log   : ${LOG_FILE}`);
        break;
    }
    case 'stop': {
        const pid = readPid();
        if (!pid || !isRunning(pid)) { console.log('  Daemon not running.'); process.exit(0); }
        process.kill(pid, 'SIGTERM');
        console.log(`  Daemon (pid ${pid}) stopped.`);
        try { require('fs').unlinkSync(PID_FILE); } catch {}
        break;
    }
    case 'status': {
        const pid = readPid();
        if (pid && isRunning(pid)) {
            console.log(`  Daemon running (pid ${pid})`);
            const pending = readdirSync(QUEUE_DIR).filter(f => f.endsWith('.task')).length;
            console.log(`  Pending tasks: ${pending}`);
        } else {
            console.log('  Daemon not running.');
        }
        break;
    }
    case 'run':
        runLoop();
        break;
    default:
        console.log(`
  cadence daemon — background task processor

  Commands:
    start    Fork daemon into background
    stop     Kill the running daemon
    status   Check if daemon is running
    run      Run in foreground (debugging)

  Queue a task:
    echo '{"task":"fix the auth bug","mode":"pipeline","cwd":"/path/to/project"}' \\
      > ~/.claude/claw/queue/$(date +%s).task
`);
}

/**
 * Shared event bus — write-to-file + EventEmitter.
 * Every agent, daemon, watcher and workflow emits here.
 * Dashboard tails this file over SSE.
 *
 * Event schema: { ts, type, agent, task, data, durationMs, cost }
 * Types: agent_start | agent_done | agent_error | task_start | task_done |
 *        step_skip | workflow_start | workflow_done | daemon_pickup | watch_trigger
 */

import { EventEmitter } from 'events';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const LOG_DIR  = join(homedir(), '.claude', 'claw');
const LOG_FILE = join(LOG_DIR, 'events.jsonl');

mkdirSync(LOG_DIR, { recursive: true });

class Bus extends EventEmitter {}
export const bus = new Bus();

export function emit(type, payload = {}) {
    const event = { ts: new Date().toISOString(), type, ...payload };
    try { appendFileSync(LOG_FILE, JSON.stringify(event) + '\n'); } catch {}
    bus.emit(type, event);
    bus.emit('*', event);
    return event;
}

export { LOG_FILE };

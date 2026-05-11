/**
 * Agent runner — spawns a single claude -p call with role + context.
 *
 * Model mapping (via cadence proxy):
 *   PRO_MODEL   → claude-opus-4-6   → deepseek-v4-pro  (planning, review)
 *   FLASH_MODEL → claude-haiku-4-5-20251001 → deepseek-v4-flash (execution)
 *
 * Falls back to ANTHROPIC_DEFAULT_SONNET_MODEL if set.
 */

import { spawn } from 'child_process';
import { getCached, setCached } from './cache.js';

export const PRO_MODEL   = 'claude-opus-4-6';
export const FLASH_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Run a single agent.
 *
 * @param {object}   opts
 * @param {string}   opts.role         Display name (e.g. 'Planner')
 * @param {string}  [opts.model]       Claude model ID (defaults to FLASH_MODEL)
 * @param {string}  [opts.system]      Role-specific system instructions
 * @param {string}  [opts.context]     Output from previous agents
 * @param {string}   opts.task         The user's original task
 * @param {function}[opts.onToken]     Called with each stdout chunk (streaming)
 * @param {boolean} [opts.autonomous]  Skip all permission prompts — agent can
 *   read/write/edit files directly. Required for daemon and watch modes.
 * @param {string}  [opts.cwd]         Working directory (default: process.cwd())
 * @returns {Promise<string>}
 */
export function runAgent({ role, model = FLASH_MODEL, system, context, task, onToken, autonomous = false, cwd }) {
    // --cheap / CADENCE_CHEAP=1 forces all calls to the flash model
    if (process.env.CADENCE_CHEAP === '1') model = FLASH_MODEL;

    return new Promise((resolve, reject) => {
        const sections = [];
        if (system)  sections.push(`## Your Role\n${system}`);
        if (context) sections.push(`## Context From Previous Agents\n${context.trim()}`);
        sections.push(`## Task\n${task}`);
        const prompt = sections.join('\n\n');

        // Cache hit — skip API call entirely (streaming not supported for cached responses)
        if (!onToken) {
            const cached = getCached(role, model, task, context, system);
            if (cached) return resolve(cached);
        }

        const args = ['--print', '--model', model];
        if (autonomous) args.push('--dangerously-skip-permissions');
        args.push(prompt);

        const child = spawn('claude', args, {
            env: process.env,
            cwd: cwd || process.cwd(),
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let out = '';
        let err = '';

        child.stdout.on('data', (chunk) => {
            const str = chunk.toString();
            out += str;
            if (onToken) onToken(str);
        });

        child.stderr.on('data', (chunk) => {
            err += chunk.toString();
        });

        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`[${role}] claude exited ${code}: ${err.trim() || '(no stderr)'}`));
            } else {
                const result = out.trim();
                setCached(role, model, task, context, system, result);
                resolve(result);
            }
        });

        child.on('error', (e) => {
            reject(new Error(`[${role}] spawn error: ${e.message}`));
        });
    });
}

/**
 * Run multiple agents in parallel, returns array of results in same order.
 */
export async function runParallel(agentConfigs) {
    return Promise.all(agentConfigs.map(cfg => runAgent(cfg)));
}

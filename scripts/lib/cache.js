/**
 * Response cache — content-addressed, TTL-based.
 *
 * Identical task+context = zero API cost on repeat.
 * Stored in ~/.cadence/cache/<sha256>.json
 *
 * Config (env vars):
 *   CADENCE_CACHE=0          Disable cache entirely
 *   CADENCE_CACHE_TTL=3600   TTL in seconds (default: 1 hour)
 *   CADENCE_CACHE_MAX=200    Max entries before pruning oldest
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CACHE_DIR = join(homedir(), '.cadence', 'cache');
const ENABLED   = process.env.CADENCE_CACHE !== '0';
const TTL       = parseInt(process.env.CADENCE_CACHE_TTL || '3600', 10) * 1000; // ms
const MAX_ENTRIES = parseInt(process.env.CADENCE_CACHE_MAX || '200', 10);

function cacheKey(role, model, task, context, system) {
    const payload = JSON.stringify({ role, model, task: task?.trim(), context: context?.trim(), system: system?.trim() });
    return createHash('sha256').update(payload).digest('hex');
}

function cacheFile(key) {
    return join(CACHE_DIR, `${key}.json`);
}

function pruneIfNeeded() {
    try {
        const files = readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
        if (files.length <= MAX_ENTRIES) return;
        // Sort by mtime, delete oldest
        const sorted = files
            .map(f => ({ f, mtime: statSync(join(CACHE_DIR, f)).mtimeMs }))
            .sort((a, b) => a.mtime - b.mtime);
        for (let i = 0; i < sorted.length - MAX_ENTRIES; i++) {
            try { unlinkSync(join(CACHE_DIR, sorted[i].f)); } catch {}
        }
    } catch {}
}

export function getCached(role, model, task, context, system) {
    if (!ENABLED) return null;
    try {
        mkdirSync(CACHE_DIR, { recursive: true });
        const file = cacheFile(cacheKey(role, model, task, context, system));
        if (!existsSync(file)) return null;
        const entry = JSON.parse(readFileSync(file, 'utf8'));
        if (Date.now() - entry.ts > TTL) { unlinkSync(file); return null; }
        return entry.result;
    } catch {
        return null;
    }
}

export function setCached(role, model, task, context, system, result) {
    if (!ENABLED) return;
    try {
        mkdirSync(CACHE_DIR, { recursive: true });
        const key  = cacheKey(role, model, task, context, system);
        writeFileSync(cacheFile(key), JSON.stringify({ result, ts: Date.now(), role, model }));
        pruneIfNeeded();
    } catch {}
}

export function clearCache() {
    try {
        const files = readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
        for (const f of files) try { unlinkSync(join(CACHE_DIR, f)); } catch {}
        return files.length;
    } catch { return 0; }
}

export function cacheStats() {
    try {
        mkdirSync(CACHE_DIR, { recursive: true });
        const files = readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
        const now   = Date.now();
        const live  = files.filter(f => {
            try { return now - JSON.parse(readFileSync(join(CACHE_DIR, f), 'utf8')).ts < TTL; }
            catch { return false; }
        });
        return { total: files.length, live: live.length, ttlSeconds: TTL / 1000, enabled: ENABLED };
    } catch { return { total: 0, live: 0, ttlSeconds: TTL / 1000, enabled: ENABLED }; }
}

#!/usr/bin/env node
/**
 * cadence dashboard — live web UI
 *
 * Streams real-time agent events to a browser via SSE.
 * Shows: active agents, queue depth, recent results, cost estimates, timeline.
 *
 * Usage:
 *   node scripts/dashboard.js          # start on :3210
 *   node scripts/dashboard.js 4000     # custom port
 *   cadence dashboard
 */

import { createServer } from 'http';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const PORT        = parseInt(process.argv[2] || process.env.DASHBOARD_PORT || '3210', 10);
const CLAW_DIR    = join(homedir(), '.claude', 'claw');
const EVENTS_LOG  = join(CLAW_DIR, 'events.jsonl');
const QUEUE_DIR   = join(CLAW_DIR, 'queue');
const RESULTS_DIR = join(CLAW_DIR, 'results');

// ---------------------------------------------------------------------------
// HTML — XSS-safe: all user data goes through esc() before DOM insertion
// ---------------------------------------------------------------------------

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>cadence — live dashboard</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d1117;color:#e6edf3;font-family:'SF Mono',monospace;font-size:13px;padding:20px}
  h1{color:#58a6ff;font-size:18px;margin-bottom:16px;letter-spacing:1px}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
  .card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px}
  .card .label{color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
  .card .value{font-size:24px;font-weight:700;color:#58a6ff}
  .card .sub{color:#8b949e;font-size:11px;margin-top:4px}
  #timeline{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px;margin-bottom:20px;max-height:420px;overflow-y:auto}
  #timeline h2{color:#8b949e;font-size:12px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px}
  .event{padding:6px 0;border-bottom:1px solid #21262d;display:flex;gap:12px;align-items:flex-start}
  .event:last-child{border-bottom:none}
  .ts{color:#484f58;min-width:90px;font-size:11px;padding-top:1px}
  .badge{padding:1px 6px;border-radius:3px;font-size:11px;min-width:100px;text-align:center}
  .b-agent_start{background:#1f4f2a;color:#56d364}
  .b-agent_done{background:#1c3a5e;color:#58a6ff}
  .b-agent_error{background:#5a1a1a;color:#ff7b72}
  .b-workflow_start,.b-workflow_done{background:#3d2b00;color:#e3b341}
  .b-daemon_pickup,.b-watch_trigger{background:#2d1b69;color:#d2a8ff}
  .b-step_skip{background:#21262d;color:#8b949e}
  .msg{flex:1;color:#c9d1d9;line-height:1.4}
  #dot{width:8px;height:8px;border-radius:50%;background:#56d364;display:inline-block;margin-right:8px;box-shadow:0 0 6px #56d364}
  #dot.dead{background:#484f58;box-shadow:none}
  .status-bar{display:flex;align-items:center;color:#8b949e;font-size:12px;margin-bottom:16px}
</style>
</head>
<body>
<h1>cadence live dashboard</h1>
<div class="status-bar"><span id="dot"></span><span id="status">connecting...</span></div>
<div class="grid">
  <div class="card"><div class="label">Queue</div><div class="value" id="stat-queue">-</div><div class="sub">pending tasks</div></div>
  <div class="card"><div class="label">Active</div><div class="value" id="stat-active">0</div><div class="sub">running agents</div></div>
  <div class="card"><div class="label">Completed</div><div class="value" id="stat-done">-</div><div class="sub">this session</div></div>
  <div class="card"><div class="label">Est. Cost</div><div class="value" id="stat-cost">$0.00</div><div class="sub">approx today</div></div>
</div>
<div id="timeline"><h2>Event stream</h2><div id="events"></div></div>
<script>
// esc() sanitizes all user-controlled strings before DOM insertion
function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

const stats = { active: 0, done: 0, cost: 0 };
const src = new EventSource('/events');

src.onopen = () => {
  document.getElementById('status').textContent = 'connected — streaming live';
  document.getElementById('dot').classList.remove('dead');
};
src.onerror = () => {
  document.getElementById('status').textContent = 'disconnected — retrying...';
  document.getElementById('dot').classList.add('dead');
};

src.addEventListener('stats', e => {
  const d = JSON.parse(e.data);
  document.getElementById('stat-queue').textContent = d.queue;
  document.getElementById('stat-done').textContent  = d.done;
});

src.addEventListener('event', e => {
  const ev = JSON.parse(e.data);
  updateStats(ev);
  appendEvent(ev);
});

function updateStats(ev) {
  if (ev.type === 'agent_start') stats.active++;
  if (ev.type === 'agent_done')  { stats.active = Math.max(0, stats.active - 1); stats.done++; }
  if (ev.type === 'agent_error') stats.active = Math.max(0, stats.active - 1);
  if (ev.durationMs) {
    const isPro = (ev.model || '').includes('opus');
    stats.cost += ((ev.outputLen || 500) / 1e6) * (isPro ? 650 : 50);
  }
  document.getElementById('stat-active').textContent = stats.active;
  document.getElementById('stat-done').textContent   = stats.done;
  document.getElementById('stat-cost').textContent   = '$' + stats.cost.toFixed(3);
}

function appendEvent(ev) {
  const div = document.createElement('div');
  div.className = 'event';

  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = new Date(ev.ts).toLocaleTimeString();

  const badge = document.createElement('span');
  badge.className = 'badge b-' + esc(ev.type);
  badge.textContent = ev.type.replace(/_/g, ' ');

  const msg = document.createElement('span');
  msg.className = 'msg';
  msg.textContent = formatMsg(ev);  // textContent — no HTML, fully safe

  div.appendChild(ts);
  div.appendChild(badge);
  div.appendChild(msg);

  const container = document.getElementById('events');
  container.prepend(div);
  if (container.children.length > 200) container.lastChild.remove();
}

function formatMsg(ev) {
  const s = (v) => String(v ?? '').slice(0, 100);
  if (ev.type === 'agent_start')    return s(ev.agent) + ' starting — step: ' + s(ev.step);
  if (ev.type === 'agent_done')     return s(ev.agent) + ' done (' + s(ev.durationMs) + 'ms, ' + s(ev.outputLen) + ' chars)';
  if (ev.type === 'agent_error')    return s(ev.agent) + ' error: ' + s(ev.error);
  if (ev.type === 'workflow_start') return '"' + s(ev.workflow) + '" — ' + s(ev.steps) + ' steps | ' + s(ev.input);
  if (ev.type === 'workflow_done')  return '"' + s(ev.workflow) + '" done (' + s(ev.completed) + ' ok, ' + s(ev.skipped) + ' skipped)';
  if (ev.type === 'daemon_pickup')  return '[' + s(ev.mode) + '] ' + s(ev.task);
  if (ev.type === 'watch_trigger')  return s(ev.file);
  if (ev.type === 'step_skip')      return 'step "' + s(ev.step) + '" skipped — condition "' + s(ev.condition) + '" not met';
  return JSON.stringify(ev).slice(0, 120);
}
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

const sseClients = new Set();

function sendToAll(eventName, data) {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
        try { res.write(payload); } catch { sseClients.delete(res); }
    }
}

function sendStats() {
    const queue = existsSync(QUEUE_DIR)   ? readdirSync(QUEUE_DIR).filter(f => f.endsWith('.task')).length   : 0;
    const done  = existsSync(RESULTS_DIR) ? readdirSync(RESULTS_DIR).filter(f => f.endsWith('.json')).length : 0;
    sendToAll('stats', { queue, done });
}

// Tail events.jsonl and push new lines to SSE clients
let tailOffset = 0;

function tailEvents() {
    if (!existsSync(EVENTS_LOG)) return;
    try {
        const lines = readFileSync(EVENTS_LOG, 'utf8').split('\n').filter(Boolean);
        for (let i = tailOffset; i < lines.length; i++) {
            try { sendToAll('event', JSON.parse(lines[i])); } catch {}
        }
        tailOffset = lines.length;
    } catch {}
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = createServer((req, res) => {
    if (req.url === '/events') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
        });
        res.write(': connected\n\n');
        sseClients.add(res);
        sendStats();
        tailEvents(); // replay recent events for new client
        req.on('close', () => sseClients.delete(res));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  cadence dashboard`);
    console.log(`  ─────────────────────`);
    console.log(`  URL    : http://localhost:${PORT}`);
    console.log(`  Events : ${EVENTS_LOG}`);
    console.log(`  Ctrl+C to stop\n`);
});

setInterval(() => { sendStats(); tailEvents(); }, 2000);
process.on('SIGINT', () => { console.log('\n  Dashboard stopped.'); process.exit(0); });

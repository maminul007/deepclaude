/**
 * Terminal display helpers for clawbot multi-agent output.
 */

const COLORS = {
    reset:   '\x1b[0m',
    bold:    '\x1b[1m',
    dim:     '\x1b[2m',
    cyan:    '\x1b[36m',
    green:   '\x1b[32m',
    yellow:  '\x1b[33m',
    blue:    '\x1b[34m',
    magenta: '\x1b[35m',
    red:     '\x1b[31m',
    white:   '\x1b[37m',
};

const AGENT_COLORS = {
    Planner:    COLORS.magenta,
    Researcher: COLORS.blue,
    Architect:  COLORS.cyan,
    Coder:      COLORS.green,
    Tester:     COLORS.yellow,
    Reviewer:   COLORS.magenta,
    Synthesizer:COLORS.cyan,
};

function color(text, ...codes) {
    return codes.join('') + text + COLORS.reset;
}

export function banner(mode, session, backend) {
    const autoRoute = process.env.AUTO_ROUTE === '1' ? ' + auto-route' : '';
    console.log(`
${color('  ╔══════════════════════════════════════╗', COLORS.bold, COLORS.cyan)}
${color('  ║     clawbot — multi-agent mode       ║', COLORS.bold, COLORS.cyan)}
${color('  ╚══════════════════════════════════════╝', COLORS.bold, COLORS.cyan)}
  ${color('Mode   :', COLORS.dim)} ${color(mode, COLORS.bold)}
  ${color('Session:', COLORS.dim)} ${session}
  ${color('Backend:', COLORS.dim)} ${backend || 'claude (direct)'}${autoRoute}

  ${color('Modes: swarm | pipeline | autoloop | quit', COLORS.dim)}
`);
}

export function agentHeader(role, model, index, total) {
    const tag = total ? `[${index}/${total}]` : '';
    const agentColor = AGENT_COLORS[role] || COLORS.white;
    console.log(`\n${color(`  ▶ ${role} ${tag}`, COLORS.bold, agentColor)} ${color(`(${model})`, COLORS.dim)}`);
    console.log(color('  ' + '─'.repeat(50), COLORS.dim));
}

export function agentOutput(text) {
    const lines = text.split('\n');
    for (const line of lines) {
        console.log(`  ${line}`);
    }
}

export function agentDone(role, ms) {
    console.log(color(`  ✓ ${role} done in ${(ms / 1000).toFixed(1)}s`, COLORS.dim));
}

export function taskHeader(task) {
    console.log(`\n${color('  Task:', COLORS.bold, COLORS.cyan)} ${task}\n`);
}

export function phaseHeader(label) {
    console.log(`\n${color(`  ═══ ${label} ═══`, COLORS.bold, COLORS.yellow)}`);
}

export function success(msg) {
    console.log(`\n${color('  ✅ ' + msg, COLORS.bold, COLORS.green)}\n`);
}

export function error(msg) {
    console.log(`\n${color('  ✗ ' + msg, COLORS.red)}\n`);
}

export function thinking(role) {
    process.stdout.write(color(`  ⟳ ${role} thinking...`, COLORS.dim));
}

export function clearLine() {
    process.stdout.write('\r' + ' '.repeat(40) + '\r');
}

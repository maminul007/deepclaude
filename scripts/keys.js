#!/usr/bin/env node
/**
 * cadence keys — encrypted API key manager
 *
 * Usage:
 *   node scripts/keys.js init               Create a new keystore
 *   node scripts/keys.js add <NAME> <value> Add/update a key
 *   node scripts/keys.js list               List stored key names
 *   node scripts/keys.js remove <NAME>      Delete a key
 *   node scripts/keys.js export             Print export statements (for sourcing)
 *   node scripts/keys.js verify             Check master password is correct
 *
 * All commands prompt for master password interactively (never passed as arg).
 * Keystore lives at ~/.cadence/keystore.enc (AES-256-GCM, chmod 600).
 */

import { createInterface } from 'readline';
import {
    keystoreExists, createKeystore, setKey, deleteKey,
    listKeys, exportKeys, STORE_FILE,
} from './lib/keystore.js';

// ---------------------------------------------------------------------------
// Password prompt (hides input)
// ---------------------------------------------------------------------------

function promptPassword(label = 'Master password') {
    return new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        process.stdout.write(`  ${label}: `);

        // Hide input on TTY
        if (process.stdin.isTTY) process.stdin.setRawMode(true);

        let pwd = '';
        process.stdin.resume();
        process.stdin.setEncoding('utf8');

        const onData = (ch) => {
            ch = ch.toString();
            if (ch === '\n' || ch === '\r' || ch === '\u0004') {
                if (process.stdin.isTTY) process.stdin.setRawMode(false);
                process.stdout.write('\n');
                process.stdin.removeListener('data', onData);
                rl.close();
                resolve(pwd);
            } else if (ch === '\u0003') {
                process.exit(0);
            } else if (ch === '\u007f' || ch === '\b') {
                pwd = pwd.slice(0, -1);
            } else {
                pwd += ch;
            }
        };
        process.stdin.on('data', onData);
    });
}

function promptConfirm(label) {
    return promptPassword(label);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdInit() {
    if (keystoreExists()) {
        console.log(`  Keystore already exists at ${STORE_FILE}`);
        console.log('  Use "keys init --overwrite" to replace it.\n');
        const args = process.argv;
        if (!args.includes('--overwrite')) process.exit(1);
    }

    console.log('\n  Creating new encrypted keystore...');
    const pwd  = await promptPassword('Choose master password');
    const pwd2 = await promptConfirm('Confirm master password');

    if (pwd !== pwd2) {
        console.error('  Passwords do not match.\n');
        process.exit(1);
    }
    if (pwd.length < 8) {
        console.error('  Password must be at least 8 characters.\n');
        process.exit(1);
    }

    createKeystore(pwd, process.argv.includes('--overwrite'));
    console.log(`\n  Keystore created at ${STORE_FILE} (chmod 600)\n`);
}

async function cmdAdd(name, value) {
    if (!name) { console.error('  Usage: keys add <NAME> [value]\n'); process.exit(1); }
    const pwd = await promptPassword('Master password');

    const val = value || process.env[name] || '';
    if (!val) {
        console.error(`  No value provided. Pass it as argument or set ${name} env var.\n`);
        process.exit(1);
    }

    setKey(pwd, name, val);
    console.log(`\n  Stored: ${name} = ****${val.slice(-4)}\n`);
}

async function cmdList() {
    const pwd = await promptPassword('Master password');
    const keys = listKeys(pwd);

    if (!keys.length) {
        console.log('\n  Keystore is empty. Use: cadence keys add <NAME> <value>\n');
        return;
    }

    console.log(`\n  Stored keys (${keys.length}):`);
    for (const k of keys) console.log(`    ${k}`);
    console.log('');
}

async function cmdRemove(name) {
    if (!name) { console.error('  Usage: keys remove <NAME>\n'); process.exit(1); }
    const pwd = await promptPassword('Master password');
    deleteKey(pwd, name);
    console.log(`\n  Removed: ${name}\n`);
}

async function cmdExport() {
    const pwd = await promptPassword('Master password');
    const keys = exportKeys(pwd);

    console.log('\n  # Paste into your shell or source this output:');
    for (const [k, v] of Object.entries(keys)) {
        // Mask value in display but print real value for sourcing
        console.log(`export ${k}="${v}"`);
    }
    console.log('');
}

async function cmdVerify() {
    const pwd = await promptPassword('Master password');
    try {
        const keys = listKeys(pwd);
        console.log(`\n  Keystore OK — ${keys.length} key(s) stored.\n`);
    } catch (e) {
        console.error(`\n  ${e.message}\n`);
        process.exit(1);
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const [,, cmd, arg1, arg2] = process.argv;

const COMMANDS = {
    init:    cmdInit,
    add:     () => cmdAdd(arg1, arg2),
    list:    cmdList,
    remove:  () => cmdRemove(arg1),
    export:  cmdExport,
    verify:  cmdVerify,
};

if (!cmd || !COMMANDS[cmd]) {
    console.log(`
  cadence keys — encrypted API key manager

  Commands:
    init               Create a new keystore
    add <NAME> [value] Store a key (prompts password)
    list               List key names
    remove <NAME>      Delete a key
    export             Print export statements for all keys
    verify             Verify master password

  Keystore: ${STORE_FILE} (AES-256-GCM, owner-read only)
`);
    process.exit(0);
}

COMMANDS[cmd]().catch(e => {
    console.error(`  Error: ${e.message}\n`);
    process.exit(1);
});

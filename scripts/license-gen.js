#!/usr/bin/env node
/**
 * cadence license-gen — issue signed license keys (SERVER SIDE ONLY)
 *
 * KEEP THIS SCRIPT AND THE PRIVATE KEY OFF YOUR PUBLIC REPO.
 * The private key file must never be distributed with the CLI.
 *
 * Usage:
 *   node scripts/license-gen.js generate \
 *     --email user@example.com \
 *     --tier pro \
 *     --days 365 \
 *     --key /path/to/private.key
 *
 *   node scripts/license-gen.js generate \
 *     --email corp@example.com \
 *     --tier enterprise \
 *     --seats 10 \
 *     --days 365 \
 *     --key /path/to/private.key
 *
 * Generate keypair (run once, keep private.key safe):
 *   node scripts/license-gen.js keygen --out ./keys/
 */

import { sign as cryptoSign, generateKeyPairSync } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

function b64u(buf) {
    return Buffer.from(buf).toString('base64url');
}

function signLicense(payload, privateKeyPem) {
    const header  = b64u(JSON.stringify({ alg: 'EdDSA', typ: 'LIC' }));
    const body    = b64u(JSON.stringify(payload));
    const msg     = Buffer.from(`${header}.${body}`);



    const sig     = b64u(cryptoSign(null, msg, privateKeyPem));

    return `${header}.${body}.${sig}`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const cmd  = args[0];

function getArg(name) {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : null;
}

if (cmd === 'keygen') {
    const outDir = getArg('--out') || '.';
    mkdirSync(outDir, { recursive: true });

    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
        publicKeyEncoding:  { type: 'spki',  format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const pubFile  = join(outDir, 'cadence-public.key');
    const privFile = join(outDir, 'cadence-private.key');
    writeFileSync(pubFile,  publicKey);
    writeFileSync(privFile, privateKey);

    console.log('\n  Keypair generated:');
    console.log(`  Public key  : ${pubFile}  ← embed this in scripts/lib/license.js`);
    console.log(`  Private key : ${privFile} ← keep this on your license server ONLY\n`);
    console.log('  Public key PEM:');
    console.log(publicKey);

} else if (cmd === 'generate') {
    const email   = getArg('--email');
    const tier    = getArg('--tier')  || 'pro';
    const days    = parseInt(getArg('--days') || '365', 10);
    const seats   = parseInt(getArg('--seats') || '1', 10);
    const keyFile = getArg('--key');

    if (!email || !keyFile) {
        console.error('  Usage: node license-gen.js generate --email <email> --tier <tier> --days <days> --key <private.key>');
        process.exit(1);
    }

    const FEATURES = {
        free:       ['swarm', 'pipeline'],
        pro:        ['swarm', 'pipeline', 'autoloop', 'daemon', 'watch', 'workflow', 'dashboard', 'autonomous'],
        enterprise: ['swarm', 'pipeline', 'autoloop', 'daemon', 'watch', 'workflow', 'dashboard', 'autonomous'],
    };

    if (!FEATURES[tier]) {
        console.error(`  Unknown tier "${tier}". Use: free, pro, enterprise`);
        process.exit(1);
    }

    const now = Math.floor(Date.now() / 1000);
    const exp = now + (days * 86400);

    const payload = {
        sub:      email,
        email,
        tier,
        seats,
        features: FEATURES[tier],
        iat:      now,
        exp,
        iss:      'cadence.sh',
    };

    let privateKeyPem;
    try { privateKeyPem = readFileSync(keyFile, 'utf8'); }
    catch (e) { console.error(`  Cannot read key file: ${e.message}`); process.exit(1); }

    const token = signLicense(payload, privateKeyPem);

    console.log('\n  License key generated:');
    console.log(`  Email  : ${email}`);
    console.log(`  Tier   : ${tier}`);
    console.log(`  Seats  : ${seats}`);
    console.log(`  Expiry : ${new Date(exp * 1000).toLocaleDateString()} (${days} days)`);
    console.log(`\n  Key:\n  ${token}\n`);

} else {
    console.log(`
  cadence license-gen — issue signed license keys (SERVER SIDE ONLY)

  Commands:
    keygen --out <dir>                         Generate a new Ed25519 keypair
    generate --email <e> --tier <t> --days <n> --key <private.key>
                                               Issue a license key

  Tiers: free | pro | enterprise
`);
}

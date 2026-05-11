#!/usr/bin/env node
/**
 * cadence upgrade — CLI payment flow
 *
 * Opens a Stripe Checkout in your browser, polls for payment,
 * then auto-issues and activates your Pro license key.
 *
 * Usage:
 *   cadence upgrade                  Interactive: choose plan + enter email
 *   cadence upgrade --plan pro       Skip plan prompt
 *   cadence upgrade --email x@y.com  Skip email prompt
 *   cadence manage                   Open Stripe billing portal
 *
 * Required env vars (or store in keystore):
 *   STRIPE_SECRET_KEY          sk_live_...
 *   STRIPE_PRO_PRICE_ID        price_xxx  (monthly Pro)
 *   STRIPE_PRO_ANNUAL_PRICE_ID price_xxx  (annual Pro, optional)
 *   CADENCE_LICENSE_API        https://license.cadence.sh  (your Cloudflare Worker)
 */

import { createInterface } from 'readline';
import { createCheckoutSession, getCheckoutSession } from './lib/stripe.js';
import { activateLicense, licenseStatus } from './lib/license.js';
import { get as httpsGet } from 'https';
import { spawnSync } from 'child_process';

// ---------------------------------------------------------------------------
// Config — loaded from env (keystore auto-loads these on startup)
// ---------------------------------------------------------------------------

const STRIPE_KEY      = process.env.STRIPE_SECRET_KEY;
const LICENSE_API     = process.env.CADENCE_LICENSE_API || 'https://license.cadence.sh';
const POLL_INTERVAL   = 3000;   // ms between Stripe status checks
const POLL_TIMEOUT    = 600000; // 10 minutes max

const PLANS = {
    pro: {
        label:    'Pro — $29/month',
        priceEnv: 'STRIPE_PRO_PRICE_ID',
        days:     31,
        tier:     'pro',
    },
    pro_annual: {
        label:    'Pro Annual — $249/year (save $99)',
        priceEnv: 'STRIPE_PRO_ANNUAL_PRICE_ID',
        days:     366,
        tier:     'pro',
        mode:     'payment',
    },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function prompt(rl, question) {
    return new Promise(resolve => rl.question(question, resolve));
}

function openBrowser(url) {
    const platform = process.platform;
    const cmd = platform === 'darwin' ? 'open'
              : platform === 'win32'  ? 'start'
              : 'xdg-open';
    spawnSync(cmd, [url], { stdio: 'ignore' });
}

function httpsGetJson(url) {
    return new Promise((resolve, reject) => {
        httpsGet(url, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch { reject(new Error('Invalid response from license API')); }
            });
        }).on('error', reject);
    });
}

// Animated waiting spinner
function startSpinner(label) {
    const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
    let i = 0;
    const interval = setInterval(() => {
        process.stdout.write(`\r  ${frames[i++ % frames.length]} ${label}   `);
    }, 120);
    return () => { clearInterval(interval); process.stdout.write('\r' + ' '.repeat(60) + '\r'); };
}

// ---------------------------------------------------------------------------
// Main payment flow
// ---------------------------------------------------------------------------

async function runUpgrade() {
    // Check current license first
    const current = licenseStatus();
    if (current.tier !== 'Free') {
        console.log(`\n  You already have Cadence ${current.tier} (${current.email}).`);
        console.log(`  Use "cadence manage" to manage your subscription.\n`);
        process.exit(0);
    }

    if (!STRIPE_KEY) {
        console.error('\n  STRIPE_SECRET_KEY not set.');
        console.error('  Add it: cadence keys add STRIPE_SECRET_KEY sk_live_...\n');
        process.exit(1);
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    console.log('\n  ┌─────────────────────────────────┐');
    console.log('  │   Upgrade to Cadence Pro        │');
    console.log('  └─────────────────────────────────┘\n');

    // Plan selection
    const planArg = process.argv.find(a => a.startsWith('--plan='))?.split('=')[1]
                 || (process.argv.includes('--plan') ? process.argv[process.argv.indexOf('--plan') + 1] : null);

    let planKey = planArg && PLANS[planArg] ? planArg : null;

    if (!planKey) {
        console.log('  Plans:');
        console.log('    1. Pro — $29/month       (all features, cancel anytime)');
        console.log('    2. Pro Annual — $249/year (save $99)\n');
        const choice = await prompt(rl, '  Choose plan [1/2]: ');
        planKey = choice.trim() === '2' ? 'pro_annual' : 'pro';
    }

    const plan = PLANS[planKey];
    const priceId = process.env[plan.priceEnv];

    if (!priceId) {
        console.error(`\n  ${plan.priceEnv} not set. Add it to your keystore.\n`);
        rl.close();
        process.exit(1);
    }

    // Email
    const emailArg = process.argv.find(a => a.startsWith('--email='))?.split('=')[1]
                  || (process.argv.includes('--email') ? process.argv[process.argv.indexOf('--email') + 1] : null);

    const email = emailArg || (await prompt(rl, '  Email address : ')).trim();
    rl.close();

    if (!email || !email.includes('@')) {
        console.error('\n  Invalid email address.\n');
        process.exit(1);
    }

    // Create Stripe Checkout session
    const stopCreating = startSpinner('Creating secure checkout...');
    let session;
    try {
        session = await createCheckoutSession({
            secretKey:  STRIPE_KEY,
            priceId,
            email,
            mode:       plan.mode || 'subscription',
            successUrl: `${LICENSE_API}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancelUrl:  `${LICENSE_API}/cancel`,
        });
    } catch (e) {
        stopCreating();
        console.error(`\n  Checkout error: ${e.message}\n`);
        process.exit(1);
    }
    stopCreating();

    console.log('\n  ✓ Secure checkout ready\n');
    console.log(`  Opening: ${session.url}\n`);
    openBrowser(session.url);
    console.log('  Complete payment in your browser, then come back here.\n');

    // Poll for payment completion
    const stopPolling = startSpinner('Waiting for payment...');
    const deadline    = Date.now() + POLL_TIMEOUT;

    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL));

        let stripeSession;
        try {
            stripeSession = await getCheckoutSession(session.id, STRIPE_KEY);
        } catch { continue; }

        if (stripeSession.payment_status === 'paid') {
            stopPolling();

            // Request license key from issuance endpoint
            const stopIssuing = startSpinner('Issuing license key...');
            try {
                const data = await httpsGetJson(
                    `${LICENSE_API}/issue?session_id=${session.id}&email=${encodeURIComponent(email)}`
                );
                stopIssuing();

                if (!data.key) throw new Error(data.error || 'No key returned');

                activateLicense(data.key);

                const s = licenseStatus();
                console.log('\n  ✓ Payment confirmed!');
                console.log('  ✓ License activated\n');
                console.log(`  Plan    : ${s.tier}`);
                console.log(`  Email   : ${s.email}`);
                console.log(`  Expires : ${s.expiry}`);
                console.log(`  Usage   : ${s.usage}\n`);
                console.log('  You now have access to all Cadence Pro features.');
                console.log('  Run "cadence --claw" to start.\n');
            } catch (e) {
                stopIssuing();
                console.error(`\n  License issuance failed: ${e.message}`);
                console.error(`  Email support@cadence.sh with your session ID: ${session.id}\n`);
                process.exit(1);
            }
            process.exit(0);
        }

        if (stripeSession.status === 'expired') {
            stopPolling();
            console.log('\n  Checkout session expired. Run "cadence upgrade" to try again.\n');
            process.exit(1);
        }
    }

    stopPolling();
    console.log('\n  Timed out waiting for payment. Your session is still valid:');
    console.log(`  ${session.url}\n`);
    console.log(`  Once paid, activate manually with:`);
    console.log(`  cadence license activate <key-from-email>\n`);
    process.exit(1);
}

async function runManage() {
    console.log('\n  Opening Stripe billing portal...\n');
    // Without customer ID stored, redirect to a generic portal URL
    const portalUrl = `${LICENSE_API}/portal`;
    openBrowser(portalUrl);
    console.log(`  Opened: ${portalUrl}\n`);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const [,, cmd] = process.argv;

if (cmd === 'manage') {
    runManage().catch(e => { console.error(e.message); process.exit(1); });
} else {
    runUpgrade().catch(e => { console.error(`\n  Error: ${e.message}\n`); process.exit(1); });
}

#!/usr/bin/env node
/**
 * cadence license — activate, check, and manage your Cadence license
 *
 * Usage:
 *   cadence license activate <key>   Activate a license key
 *   cadence license status           Show current plan and usage
 *   cadence license deactivate       Remove the stored license
 *
 * Get a license at: https://cadence.sh/pricing
 */

import { activateLicense, licenseStatus, deactivateLicense, TIERS } from './lib/license.js';

const [,, cmd, arg] = process.argv;

switch (cmd) {

    case 'activate': {
        if (!arg) {
            console.error('  Usage: cadence license activate <key>');
            console.error('  Get a key at: https://cadence.sh/pricing\n');
            process.exit(1);
        }
        try {
            const payload = activateLicense(arg.trim());
            const tier    = TIERS[payload.tier];
            console.log('\n  License activated successfully!\n');
            console.log(`  Plan     : ${tier.label}`);
            console.log(`  Email    : ${payload.email || payload.sub}`);
            console.log(`  Expires  : ${payload.exp === Infinity ? 'never' : new Date(payload.exp * 1000).toLocaleDateString()}`);
            console.log(`  Features : ${tier.features.join(', ')}\n`);
        } catch (e) {
            console.error(`\n  Activation failed: ${e.message}\n`);
            process.exit(1);
        }
        break;
    }

    case 'status': {
        const s = licenseStatus();
        console.log('\n  Cadence License Status');
        console.log('  ─────────────────────');
        console.log(`  Plan     : ${s.tier}`);
        console.log(`  Email    : ${s.email}`);
        console.log(`  Expires  : ${s.expiry}`);
        console.log(`  Usage    : ${s.usage}`);
        console.log(`  Features : ${s.features.join(', ')}\n`);
        if (s.tier === 'Free') {
            console.log('  Upgrade to Pro for unlimited usage + all features.');
            console.log('  https://cadence.sh/pricing\n');
        }
        break;
    }

    case 'deactivate': {
        deactivateLicense();
        console.log('\n  License deactivated. Reverted to free tier.\n');
        break;
    }

    default:
        console.log(`
  cadence license — manage your Cadence plan

  Commands:
    activate <key>   Activate a license key
    status           Show current plan, features, and usage
    deactivate       Remove stored license (reverts to free tier)

  Plans:
    Free    — swarm + pipeline, 20 agent calls/day
    Pro     — all features, unlimited calls ($29/mo)
    Enterprise — Pro + multi-seat + priority support

  Get a license: https://cadence.sh/pricing
`);
}

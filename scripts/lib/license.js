/**
 * Cadence license engine — offline JWT validation, feature gating, usage tracking.
 *
 * License key format: base64url(header).base64url(payload).base64url(signature)
 *   header  : { "alg": "EdDSA", "typ": "LIC" }
 *   payload : { sub, email, tier, features[], exp, iat, seats }
 *   sig     : Ed25519 over header.payload
 *
 * Tiers:
 *   free       swarm + pipeline only, 20 agent calls/day
 *   pro        all features, unlimited
 *   enterprise all features, multi-seat
 */

import { verify as cryptoVerify, createPublicKey } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Embedded public key — private key stays on your license server only
// ---------------------------------------------------------------------------

const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAiKByJ4cBmqPNXhpgMqGHMvvsqsEO8E87KBBQ9hdfiPU=
-----END PUBLIC KEY-----`;

// ---------------------------------------------------------------------------
// Feature definitions per tier
// ---------------------------------------------------------------------------

export const TIERS = {
    free: {
        features:   ['swarm', 'pipeline'],
        dailyLimit: 20,
        label:      'Free',
    },
    pro: {
        features:   ['swarm', 'pipeline', 'autoloop', 'daemon', 'watch', 'workflow', 'dashboard', 'autonomous'],
        dailyLimit: Infinity,
        label:      'Pro',
    },
    enterprise: {
        features:   ['swarm', 'pipeline', 'autoloop', 'daemon', 'watch', 'workflow', 'dashboard', 'autonomous'],
        dailyLimit: Infinity,
        label:      'Enterprise',
    },
};

const FREE_TIER = { tier: 'free', email: 'unlicensed', features: TIERS.free.features, exp: Infinity };

// ---------------------------------------------------------------------------
// Storage — ~/.cadence/license.json (plaintext — payload is already verifiable)
// ---------------------------------------------------------------------------

const LICENSE_DIR  = join(homedir(), '.cadence');
const LICENSE_FILE = join(LICENSE_DIR, 'license.json');
const USAGE_FILE   = join(LICENSE_DIR, 'usage.json');

// ---------------------------------------------------------------------------
// JWT helpers (no npm deps)
// ---------------------------------------------------------------------------

function b64uEncode(str) {
    return Buffer.from(str).toString('base64url');
}

function b64uDecode(str) {
    return Buffer.from(str, 'base64url').toString('utf8');
}

function parseJwt(token) {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid license key format.');
    const header  = JSON.parse(b64uDecode(parts[0]));
    const payload = JSON.parse(b64uDecode(parts[1]));
    const sig     = Buffer.from(parts[2], 'base64url');
    const msg     = Buffer.from(`${parts[0]}.${parts[1]}`);
    return { header, payload, sig, msg };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateLicenseKey(token) {
    const { payload, sig, msg } = parseJwt(token);

    // Signature check


    if (!cryptoVerify(null, msg, PUBLIC_KEY_PEM, sig)) {
        throw new Error('License key signature invalid. Key may be tampered or fake.');
    }

    // Expiry check
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
        throw new Error(`License expired on ${new Date(payload.exp * 1000).toLocaleDateString()}.`);
    }

    // Tier sanity
    if (!TIERS[payload.tier]) {
        throw new Error(`Unknown tier "${payload.tier}" in license.`);
    }

    return payload;
}

// ---------------------------------------------------------------------------
// Activation & retrieval
// ---------------------------------------------------------------------------

export function activateLicense(token) {
    const payload = validateLicenseKey(token);
    mkdirSync(LICENSE_DIR, { recursive: true });
    writeFileSync(LICENSE_FILE, JSON.stringify({ token, payload }, null, 2));
    return payload;
}

export function getLicense() {
    if (!existsSync(LICENSE_FILE)) return FREE_TIER;
    try {
        const { token, payload } = JSON.parse(readFileSync(LICENSE_FILE, 'utf8'));
        // Re-validate on every load (catches post-save expiry)
        return validateLicenseKey(token);
    } catch {
        return FREE_TIER; // corrupt or expired → fall back to free
    }
}

export function deactivateLicense() {
    if (existsSync(LICENSE_FILE)) {
        writeFileSync(LICENSE_FILE, JSON.stringify({ token: null, payload: null }));
    }
}

// ---------------------------------------------------------------------------
// Feature gating
// ---------------------------------------------------------------------------

export function hasFeature(feature) {
    const license = getLicense();
    const tier    = TIERS[license.tier] || TIERS.free;
    return tier.features.includes(feature);
}

/**
 * Call at the entry point of a gated feature.
 * Throws with a friendly upgrade message if not allowed.
 */
export function requireFeature(feature) {
    if (!hasFeature(feature)) {
        const license = getLicense();
        throw new Error(
            `"${feature}" requires Cadence Pro.\n` +
            `  Current plan : ${(TIERS[license.tier] || TIERS.free).label}\n` +
            `  Upgrade at   : https://cadence.sh/pricing\n` +
            `  Activate     : cadence license activate <key>`
        );
    }
}

// ---------------------------------------------------------------------------
// Daily usage tracking (free tier enforcement)
// ---------------------------------------------------------------------------

export function trackAndEnforceUsage() {
    const license = getLicense();
    const limit   = (TIERS[license.tier] || TIERS.free).dailyLimit;
    if (limit === Infinity) return; // paid tier — no tracking needed

    mkdirSync(LICENSE_DIR, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);

    let usage = {};
    try { usage = JSON.parse(readFileSync(USAGE_FILE, 'utf8')); } catch {}

    // Reset if new day
    if (usage.date !== today) usage = { date: today, calls: 0 };

    if (usage.calls >= limit) {
        throw new Error(
            `Free tier daily limit reached (${limit} agent calls/day).\n` +
            `  Reset at midnight. Upgrade to Pro for unlimited usage.\n` +
            `  https://cadence.sh/pricing`
        );
    }

    usage.calls++;
    writeFileSync(USAGE_FILE, JSON.stringify(usage));
}

// ---------------------------------------------------------------------------
// Status summary
// ---------------------------------------------------------------------------

export function licenseStatus() {
    const license = getLicense();
    const tier    = TIERS[license.tier] || TIERS.free;

    let usageStr = 'unlimited';
    if (tier.dailyLimit !== Infinity) {
        try {
            const today = new Date().toISOString().slice(0, 10);
            const usage = JSON.parse(readFileSync(USAGE_FILE, 'utf8'));
            const calls = usage.date === today ? usage.calls : 0;
            usageStr = `${calls}/${tier.dailyLimit} calls today`;
        } catch {
            usageStr = `0/${tier.dailyLimit} calls today`;
        }
    }

    return {
        tier:     tier.label,
        email:    license.email || license.sub || 'unlicensed',
        expiry:   license.exp === Infinity ? 'never' : new Date(license.exp * 1000).toLocaleDateString(),
        features: tier.features,
        usage:    usageStr,
    };
}

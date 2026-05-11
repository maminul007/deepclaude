/**
 * Cadence License API — Cloudflare Worker
 *
 * Deploy once to Cloudflare Workers (free tier, ~100k req/day).
 * Set these environment variables in your Worker settings:
 *
 *   STRIPE_SECRET_KEY      sk_live_...
 *   LICENSE_PRIVATE_KEY    -----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----
 *   LICENSE_TIER_PRO       pro
 *   LICENSE_DAYS           365
 *
 * Routes:
 *   GET  /issue?session_id=xxx&email=xxx   Verify payment + issue license key
 *   GET  /success?session_id=xxx           Stripe success redirect
 *   GET  /cancel                           Stripe cancel redirect
 *   GET  /portal                           Redirect to Stripe Customer Portal
 *   GET  /health                           Health check
 *
 * Deploy:
 *   npm install -g wrangler
 *   wrangler deploy workers/license-api.js
 */

// ---------------------------------------------------------------------------
// JWT signing (Ed25519) — Web Crypto API (available in CF Workers)
// ---------------------------------------------------------------------------

async function importPrivateKey(pemStr) {
    const b64 = pemStr.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
    const der  = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    return crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
}

function b64url(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function signLicense(payload, privateKeyPem) {
    const key    = await importPrivateKey(privateKeyPem);
    const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'EdDSA', typ: 'LIC' })));
    const body   = b64url(new TextEncoder().encode(JSON.stringify(payload)));
    const msg    = new TextEncoder().encode(`${header}.${body}`);
    const sig    = await crypto.subtle.sign('Ed25519', key, msg);
    return `${header}.${body}.${b64url(sig)}`;
}

// ---------------------------------------------------------------------------
// Stripe helpers
// ---------------------------------------------------------------------------

async function stripeGet(path, secretKey) {
    const res = await fetch(`https://api.stripe.com/v1/${path}`, {
        headers: {
            'Authorization': `Bearer ${secretKey}`,
            'Stripe-Version': '2024-04-10',
        },
    });
    return res.json();
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

export default {
    async fetch(request, env) {
        const url    = new URL(request.url);
        const path   = url.pathname;
        const params = url.searchParams;

        const cors = {
            'Access-Control-Allow-Origin':  '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Content-Type':                 'application/json',
        };

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: cors });
        }

        // ── GET /health ──────────────────────────────────────────────────────
        if (path === '/health') {
            return new Response(JSON.stringify({ status: 'ok' }), { headers: cors });
        }

        // ── GET /success ─────────────────────────────────────────────────────
        if (path === '/success') {
            return new Response(
                `<!DOCTYPE html><html><body style="font-family:monospace;padding:40px;background:#0d1117;color:#e6edf3">
                <h2 style="color:#56d364">✓ Payment successful!</h2>
                <p>Return to your terminal — your license is being activated automatically.</p>
                </body></html>`,
                { headers: { 'Content-Type': 'text/html' } }
            );
        }

        // ── GET /cancel ──────────────────────────────────────────────────────
        if (path === '/cancel') {
            return new Response(
                `<!DOCTYPE html><html><body style="font-family:monospace;padding:40px;background:#0d1117;color:#e6edf3">
                <h2 style="color:#f85149">Payment cancelled</h2>
                <p>Run <code>cadence upgrade</code> to try again.</p>
                </body></html>`,
                { headers: { 'Content-Type': 'text/html' } }
            );
        }

        // ── GET /portal ──────────────────────────────────────────────────────
        if (path === '/portal') {
            const portalUrl = env.STRIPE_PORTAL_URL || 'https://billing.stripe.com/p/login/xxx';
            return Response.redirect(portalUrl, 302);
        }

        // ── GET /issue ───────────────────────────────────────────────────────
        if (path === '/issue') {
            const sessionId = params.get('session_id');
            const email     = params.get('email');

            if (!sessionId || !email) {
                return new Response(JSON.stringify({ error: 'Missing session_id or email' }),
                    { status: 400, headers: cors });
            }

            // Verify payment with Stripe
            const session = await stripeGet(`checkout/sessions/${sessionId}`, env.STRIPE_SECRET_KEY);

            if (session.error) {
                return new Response(JSON.stringify({ error: 'Invalid session' }),
                    { status: 400, headers: cors });
            }

            if (session.payment_status !== 'paid') {
                return new Response(JSON.stringify({ error: 'Payment not completed', status: session.payment_status }),
                    { status: 402, headers: cors });
            }

            // Determine tier from session metadata or price
            const tier = session.metadata?.tier || env.LICENSE_TIER_PRO || 'pro';
            const days = parseInt(env.LICENSE_DAYS || '365', 10);

            const FEATURES = {
                pro:        ['swarm','pipeline','autoloop','daemon','watch','workflow','dashboard','autonomous'],
                enterprise: ['swarm','pipeline','autoloop','daemon','watch','workflow','dashboard','autonomous'],
            };

            const now = Math.floor(Date.now() / 1000);
            const payload = {
                sub:         email,
                email,
                tier,
                seats:       1,
                features:    FEATURES[tier] || FEATURES.pro,
                customer_id: session.customer || null,
                session_id:  sessionId,
                iat:         now,
                exp:         now + (days * 86400),
                iss:         'cadence.sh',
            };

            try {
                const key = await signLicense(payload, env.LICENSE_PRIVATE_KEY);
                return new Response(JSON.stringify({ key, tier, email }), { headers: cors });
            } catch (e) {
                return new Response(JSON.stringify({ error: 'Key signing failed: ' + e.message }),
                    { status: 500, headers: cors });
            }
        }

        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: cors });
    },
};

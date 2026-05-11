/**
 * Minimal Stripe API wrapper — zero npm dependencies, pure Node https.
 *
 * Only the endpoints needed for CLI payment flow:
 *   createCheckoutSession  — create a Stripe Checkout session
 *   getCheckoutSession     — poll session status
 *   createBillingPortal    — open billing portal for subscription management
 */

import { request } from 'https';

const STRIPE_API = 'api.stripe.com';

// ---------------------------------------------------------------------------
// Base request
// ---------------------------------------------------------------------------

function stripeRequest(method, path, params, secretKey) {
    return new Promise((resolve, reject) => {
        const body = params ? new URLSearchParams(params).toString() : '';

        const options = {
            hostname: STRIPE_API,
            port:     443,
            path:     `/v1/${path}`,
            method,
            headers: {
                'Authorization': `Bearer ${secretKey}`,
                'Content-Type':  'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
                'Stripe-Version': '2024-04-10',
            },
        };

        const req = request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) {
                        reject(new Error(`Stripe error: ${parsed.error.message}`));
                    } else {
                        resolve(parsed);
                    }
                } catch {
                    reject(new Error('Invalid Stripe response'));
                }
            });
        });

        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

// ---------------------------------------------------------------------------
// Checkout Session
// ---------------------------------------------------------------------------

/**
 * Create a Stripe Checkout session.
 *
 * @param {object} opts
 * @param {string} opts.secretKey     Stripe secret key
 * @param {string} opts.priceId       Stripe Price ID (e.g. price_xxx)
 * @param {string} opts.email         Pre-fill customer email
 * @param {string} opts.successUrl    Redirect after payment
 * @param {string} opts.cancelUrl     Redirect on cancel
 * @param {string} [opts.mode]        'subscription' | 'payment' (default: subscription)
 * @returns {Promise<{id, url}>}
 */
export async function createCheckoutSession({ secretKey, priceId, email, successUrl, cancelUrl, mode = 'subscription' }) {
    const params = {
        'mode':                          mode,
        'line_items[0][price]':          priceId,
        'line_items[0][quantity]':       '1',
        'customer_email':                email,
        'success_url':                   successUrl,
        'cancel_url':                    cancelUrl,
        'metadata[source]':              'cadence-cli',
    };

    const session = await stripeRequest('POST', 'checkout/sessions', params, secretKey);
    return { id: session.id, url: session.url };
}

/**
 * Get a Checkout session by ID.
 * Returns payment_status: 'paid' | 'unpaid' | 'no_payment_required'
 */
export async function getCheckoutSession(sessionId, secretKey) {
    return stripeRequest('GET', `checkout/sessions/${sessionId}`, null, secretKey);
}

/**
 * Create a billing portal session (for managing subscriptions).
 */
export async function createBillingPortal(customerId, returnUrl, secretKey) {
    return stripeRequest('POST', 'billing_portal/sessions', {
        customer:   customerId,
        return_url: returnUrl,
    }, secretKey);
}

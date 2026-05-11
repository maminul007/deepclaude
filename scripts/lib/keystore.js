/**
 * Encrypted keystore for cadence.
 *
 * Keys are stored in ~/.cadence/keystore.enc — AES-256-GCM encrypted,
 * unlocked only by your master password. File is chmod 600 (owner-read only).
 *
 * Schema (plaintext before encryption):
 *   { version: 1, keys: { DEEPSEEK_API_KEY: "sk-...", ... } }
 *
 * Crypto:
 *   - PBKDF2-SHA256, 200 000 iterations → 32-byte AES key
 *   - AES-256-GCM, random IV per write
 *   - File layout: base64( salt[32] || iv[12] || tag[16] || ciphertext )
 */

import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const STORE_DIR  = join(homedir(), '.cadence');
const STORE_FILE = join(STORE_DIR, 'keystore.enc');
const PBKDF2_ITER = 200_000;
const SALT_LEN    = 32;
const IV_LEN      = 12;
const TAG_LEN     = 16;

// ---------------------------------------------------------------------------
// Internal crypto helpers
// ---------------------------------------------------------------------------

function deriveKey(password, salt) {
    return pbkdf2Sync(password, salt, PBKDF2_ITER, 32, 'sha256');
}

function encrypt(plaintext, password) {
    const salt = randomBytes(SALT_LEN);
    const iv   = randomBytes(IV_LEN);
    const key  = deriveKey(password, salt);

    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    // salt || iv || tag || ciphertext
    const payload = Buffer.concat([salt, iv, tag, ct]);
    return payload.toString('base64');
}

function decrypt(b64payload, password) {
    const payload = Buffer.from(b64payload, 'base64');
    const salt = payload.subarray(0, SALT_LEN);
    const iv   = payload.subarray(SALT_LEN, SALT_LEN + IV_LEN);
    const tag  = payload.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
    const ct   = payload.subarray(SALT_LEN + IV_LEN + TAG_LEN);

    const key = deriveKey(password, salt);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    try {
        return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch {
        throw new Error('Wrong master password or corrupted keystore.');
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function keystoreExists() {
    return existsSync(STORE_FILE);
}

/**
 * Create a new keystore protected by masterPassword.
 * Fails if one already exists (use overwrite=true to replace).
 */
export function createKeystore(masterPassword, overwrite = false) {
    if (keystoreExists() && !overwrite) {
        throw new Error('Keystore already exists. Use --overwrite to replace.');
    }
    mkdirSync(STORE_DIR, { recursive: true });
    const payload = encrypt(JSON.stringify({ version: 1, keys: {} }), masterPassword);
    writeFileSync(STORE_FILE, payload, 'utf8');
    chmodSync(STORE_FILE, 0o600);   // owner read/write only
    chmodSync(STORE_DIR,  0o700);
}

/**
 * Load and decrypt the keystore. Returns { version, keys }.
 */
export function loadKeystore(masterPassword) {
    if (!keystoreExists()) throw new Error('No keystore found. Run: cadence keys init');
    const b64 = readFileSync(STORE_FILE, 'utf8').trim();
    const plain = decrypt(b64, masterPassword);
    return JSON.parse(plain);
}

/**
 * Save the keystore object back to disk (re-encrypts with same password).
 */
export function saveKeystore(store, masterPassword) {
    const payload = encrypt(JSON.stringify(store), masterPassword);
    writeFileSync(STORE_FILE, payload, 'utf8');
    chmodSync(STORE_FILE, 0o600);
}

/**
 * Set a key in the store.
 */
export function setKey(masterPassword, name, value) {
    const store = loadKeystore(masterPassword);
    store.keys[name] = value;
    saveKeystore(store, masterPassword);
}

/**
 * Delete a key from the store.
 */
export function deleteKey(masterPassword, name) {
    const store = loadKeystore(masterPassword);
    if (!(name in store.keys)) throw new Error(`Key '${name}' not found.`);
    delete store.keys[name];
    saveKeystore(store, masterPassword);
}

/**
 * Return all key names (never values) for display.
 */
export function listKeys(masterPassword) {
    const store = loadKeystore(masterPassword);
    return Object.keys(store.keys);
}

/**
 * Export all keys as an object — for injecting into process.env.
 * Call this at startup to load keys without exposing them to disk.
 */
export function exportKeys(masterPassword) {
    const store = loadKeystore(masterPassword);
    return store.keys;
}

export { STORE_FILE, STORE_DIR };

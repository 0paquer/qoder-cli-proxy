'use strict';

/**
 * Secret-at-rest encryption for Qoder account credentials (PATs).
 *
 * Key management:
 *   - Keys live in data/.secret-key (never in .env, never committed).
 *   - File format: { "keys": [{ "version": 1, "key": "<64 hex chars>" }] }
 *   - New encryptions always use the highest version; old versions stay so
 *     existing ciphertexts remain decryptable across key rotation.
 *
 * Ciphertext format: v<version>:<iv hex>:<auth tag hex>:<data hex>
 * Algorithm: AES-256-GCM (12-byte random IV, 16-byte auth tag).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY_FILE = path.join(__dirname, '..', 'data', '.secret-key');
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

/** @type {{ keys: Array<{ version: number, key: string }> } | null} */
let keyFileCache = null;

function loadKeyFile() {
  if (keyFileCache) return keyFileCache;

  if (fs.existsSync(KEY_FILE)) {
    const raw = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    if (!raw || !Array.isArray(raw.keys) || raw.keys.length === 0) {
      throw new Error(`Invalid secret key file: ${KEY_FILE}`);
    }
    keyFileCache = raw;
    return keyFileCache;
  }

  // First run: generate a fresh key.
  const fresh = {
    keys: [{ version: 1, key: crypto.randomBytes(32).toString('hex') }],
  };
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  fs.writeFileSync(KEY_FILE, JSON.stringify(fresh, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(KEY_FILE, 0o600); // no-op on Windows, enforced on POSIX
  } catch (_) {
    // Ignore — best effort.
  }
  keyFileCache = fresh;
  return keyFileCache;
}

function latestKeyVersion() {
  const file = loadKeyFile();
  return file.keys.reduce((max, k) => Math.max(max, k.version), 0);
}

function getKeyByVersion(version) {
  const file = loadKeyFile();
  const entry = file.keys.find((k) => k.version === version);
  if (!entry) {
    throw new Error(`Secret key version ${version} not found in ${KEY_FILE}`);
  }
  return Buffer.from(entry.key, 'hex');
}

/** Encrypt a secret. Returns "v<version>:<iv>:<tag>:<data>". */
function encryptSecret(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('encryptSecret requires a non-empty string');
  }
  const version = latestKeyVersion();
  const key = getKeyByVersion(version);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v${version}:${iv.toString('hex')}:${tag.toString('hex')}:${data.toString('hex')}`;
}

/** Decrypt a secret produced by encryptSecret. Throws on tamper/unknown version. */
function decryptSecret(ciphertext) {
  const value = String(ciphertext || '');
  const match = /^v(\d+):([0-9a-f]+):([0-9a-f]+):([0-9a-f]+)$/i.exec(value);
  if (!match) {
    throw new Error('Invalid ciphertext format (expected v<ver>:<iv>:<tag>:<data>)');
  }
  const [, versionHex, ivHex, tagHex, dataHex] = match;
  const key = getKeyByVersion(Number(versionHex));
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

/**
 * Human-recognizable fingerprint of a secret: the last 4 characters.
 * Shown in the UI so users can tell accounts apart without exposing the PAT.
 */
function fingerprintSecret(plaintext) {
  const value = String(plaintext || '');
  return value.length <= 4 ? value : value.slice(-4);
}

/** Add a new key version (rotation). Existing ciphertexts stay decryptable. */
function rotateKey() {
  const file = loadKeyFile();
  const version = latestKeyVersion() + 1;
  file.keys.push({ version, key: crypto.randomBytes(32).toString('hex') });
  fs.writeFileSync(KEY_FILE, JSON.stringify(file, null, 2), { mode: 0o600 });
  return version;
}

module.exports = {
  encryptSecret,
  decryptSecret,
  fingerprintSecret,
  rotateKey,
  latestKeyVersion,
  KEY_FILE,
};

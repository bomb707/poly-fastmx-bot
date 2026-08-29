// dk.js — Teno v2 wallet-credential integration (fetch-dk + RSA decrypt). Ported from the proven
// /home/polybots/polystack-bot src/dk.ts. Recovers the live trading wallet's private key WITHOUT ever
// storing it in plaintext or in the repo:
//
//   1) GET  /api/external/context-token   → contextToken (binds this decrypt session)
//   2) AES-encrypt the wallet address with PROTECT_KEY
//   3) POST /api/external/fetch-dk         → encryptedDecryptKey
//   4) AES-decrypt it (key = SHA-256("teno-v2-fetch-dk\0"+PROTECT_KEY+"\0"+contextToken)) → an RSA JWK
//   5) RSA-OAEP-SHA256 decrypt the local CIPHERTEXT_JSON file with that JWK → { address, privateKey }
//
// getKey() returns { address, privateKey, profile (= Polymarket funder), sign_type } — exactly the
// fields the CLOB client needs (funderAddress + signatureType), so a proxy wallet signs correctly.
//
// Env: API_KEY, PROTECT_KEY, CIPHERTEXT_JSON (path to *_rsa_ciphertext.json), optional DK_BASE_URL.
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";

// Best-effort .env load (Node ≥20.12); real shell/pm2 env still wins. (config.js does this too.)
try { process.loadEnvFile?.(new URL("../../.env", import.meta.url).pathname); } catch {}

const env = (k) => String(process.env[k] || "");
const BASE_URL = (process.env.DK_BASE_URL || "https://cred-v2.polywinbot.xyz").replace(/\/$/, "");
const CLIENT_IP_ENDPOINT = "/api/external/client-ip";
const CONTEXT_TOKEN_ENDPOINT = "/api/external/context-token";
const FETCH_DK_ENDPOINT = "/api/external/fetch-dk";

const IV_LENGTH = 12, TAG_LENGTH = 16, PLACEHOLDER_PREFIX = "paste-";
const ETH_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const B64_RE = /^[A-Za-z0-9+/]+=*$/;

/** True when the dk credential service is configured (else the executor falls back to raw env keys). */
export function dkConfigured() {
  return !!(env("API_KEY") && env("PROTECT_KEY") && env("CIPHERTEXT_JSON"));
}

function pickCiphertextB64(o) {
  for (const k of ["ciphertext", "cipher", "cipherKey"]) if (typeof o[k] === "string" && o[k].trim()) return o[k].trim();
  return "";
}

async function loadValidatedCiphertextJson(jsonPath) {
  let raw;
  try { raw = await readFile(jsonPath, "utf8"); }
  catch (e) { throw new Error("Cannot read CIPHERTEXT_JSON (" + jsonPath + "): " + (e?.message || e)); }
  let parsed; try { parsed = JSON.parse(raw); } catch { throw new Error("CIPHERTEXT_JSON is not valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("CIPHERTEXT_JSON must be a JSON object.");
  const address = typeof parsed.address === "string" ? parsed.address.trim() : "";
  if (!ETH_ADDRESS.test(address)) throw new Error("CIPHERTEXT_JSON.address must be a valid 0x 40-hex address.");
  const ciphertextB64 = pickCiphertextB64(parsed);
  if (!ciphertextB64) throw new Error('CIPHERTEXT_JSON must include a non-empty "ciphertext".');
  if (!B64_RE.test(ciphertextB64)) throw new Error("CIPHERTEXT_JSON ciphertext must look like base64.");
  return { address: address.toLowerCase(), ciphertextB64 };
}

const hasPlaceholder = (v) => typeof v !== "string" || v.length === 0 || v.startsWith(PLACEHOLDER_PREFIX);
function normalizeAddress(a) {
  if (typeof a !== "string" || !ETH_ADDRESS.test(a)) throw new Error("walletAddress must be a valid 0x 40-hex address.");
  return a.toLowerCase();
}
function ensureConfigured(walletAddress, protectKey) {
  if (hasPlaceholder(env("API_KEY"))) throw new Error("Set API_KEY (Dashboard → Generate new API key).");
  normalizeAddress(walletAddress);
  if (typeof protectKey !== "string" || protectKey.length < 4) throw new Error("PROTECT_KEY must be ≥ 4 chars.");
  if (!env("CIPHERTEXT_JSON").trim()) throw new Error("Set CIPHERTEXT_JSON to your *_rsa_ciphertext.json path.");
}

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest();

// AES-256-GCM, wire = iv(12) || ciphertext || tag(16), base64.
function aesEncryptUtf8(plaintext, protectKey) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", sha256(protectKey), iv, { authTagLength: TAG_LENGTH });
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, enc, cipher.getAuthTag()]).toString("base64");
}
function aesDecryptUtf8WithKey32(b64, key32) {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < IV_LENGTH + TAG_LENGTH) throw new Error("Invalid ciphertext");
  const iv = buf.subarray(0, IV_LENGTH), tag = buf.subarray(buf.length - TAG_LENGTH), enc = buf.subarray(IV_LENGTH, buf.length - TAG_LENGTH);
  const d = crypto.createDecipheriv("aes-256-gcm", key32, iv, { authTagLength: TAG_LENGTH });
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}
const fetchDkKey = (protectKey, contextToken) => sha256(`teno-v2-fetch-dk\0${protectKey}\0${contextToken}`);

async function getJson(url, opts) {
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  return { r, j };
}
async function fetchContextToken() {
  const { r, j } = await getJson(`${BASE_URL}${CONTEXT_TOKEN_ENDPOINT}`, { method: "GET", headers: { Authorization: `Bearer ${env("API_KEY")}` } });
  if (!r.ok) throw new Error(j.error || `context-token failed: ${r.status}`);
  if (typeof j.contextToken !== "string" || !j.contextToken.length) throw new Error("context-token response missing contextToken.");
  return j.contextToken;
}
async function callFetchDk(encryptedWalletAddress, protectKey) {
  const { r, j } = await getJson(`${BASE_URL}${FETCH_DK_ENDPOINT}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${env("API_KEY")}` },
    body: JSON.stringify({ encryptedWalletAddress, protectKey }),
  });
  if (!r.ok) {
    const d = (typeof j.error === "string" && j.error.trim()) || null;
    if (r.status === 400) throw new Error(d || "400: invalid body or wallet address could not be decrypted.");
    if (r.status === 401) throw new Error(d || "401: invalid or missing API key.");
    if (r.status === 403) throw new Error(d || "403: wallet not found, API disabled, or IP not allowed.");
    throw new Error(d || `fetch-dk failed: ${r.status}`);
  }
  return j;
}
async function fetchDecryptKeyJson(walletAddress, protectKey, contextToken) {
  const j = await callFetchDk(aesEncryptUtf8(normalizeAddress(walletAddress), protectKey), protectKey);
  if (typeof j.encryptedDecryptKey !== "string" || !j.encryptedDecryptKey.length) throw new Error("fetch-dk response missing encryptedDecryptKey.");
  return JSON.parse(aesDecryptUtf8WithKey32(j.encryptedDecryptKey, fetchDkKey(protectKey, contextToken)));
}
function rsaJwkFromKeyFile(keyFile) {
  if (typeof keyFile.decdata === "string") return JSON.parse(Buffer.from(keyFile.decdata, "base64").toString("utf8"));
  if (keyFile.jwk && typeof keyFile.jwk === "object") return keyFile.jwk;
  throw new Error("Unsupported decrypt key file: expected decdata or jwk.");
}
function rsaOaepSha256Decrypt(ciphertextB64, rsaPrivateJwk) {
  const key = crypto.createPrivateKey({ key: rsaPrivateJwk, format: "jwk" });
  return crypto.privateDecrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(ciphertextB64, "base64")).toString("utf8");
}

/**
 * Resolve the live trading wallet credentials via the dk service.
 * @returns {Promise<{address:string, privateKey:string, profile:string, sign_type:0|1|2|3}>}
 *   profile = the Polymarket funder address; sign_type = the SignatureType to pass the CLOB client.
 */
export async function getKey() {
  const contextToken = await fetchContextToken();
  const protectKey = env("PROTECT_KEY");
  if (!protectKey || protectKey.length < 4) throw new Error("PROTECT_KEY must be set and ≥ 4 chars.");
  const bundle = await loadValidatedCiphertextJson(env("CIPHERTEXT_JSON"));
  ensureConfigured(bundle.address, protectKey);
  const keyFile = await fetchDecryptKeyJson(bundle.address, protectKey, contextToken);
  if (typeof keyFile.wallet === "string" && bundle.address !== keyFile.wallet.toLowerCase())
    throw new Error("Wallet mismatch between ciphertext JSON and decrypt key from API.");
  const plain = rsaOaepSha256Decrypt(bundle.ciphertextB64, rsaJwkFromKeyFile(keyFile));
  const { address, privateKey } = JSON.parse(plain);
  if (typeof keyFile.wallet === "string" && address.toLowerCase() !== keyFile.wallet.toLowerCase())
    throw new Error("Decrypted EOA does not match wallet in decrypt key payload.");
  return { address, privateKey, profile: keyFile.profile, sign_type: keyFile.sign_type };
}

// ============================================================================
// Server-side Firebase Auth verification (src/auth.js)
// ============================================================================
// The dashboard hides itself behind a Firebase login, but that is a *client*
// side control — anything can call the local API directly with curl or from a
// malicious page in another tab. This module is the server-side half: it
// cryptographically verifies the Firebase ID token that the browser sends in
// the Authorization header before any request is allowed to touch the Google
// Sheet or the Telegram bot.
//
// It has no npm dependencies. Firebase ID tokens are RS256 JWTs signed by
// Google, and Google publishes the matching X.509 certificates at a well known
// URL, so verification is: fetch certs (cached), check the signature, then
// check every claim.
// ============================================================================

const crypto = require('crypto');

/** Where Google publishes the public certs for Firebase session tokens. */
const CERT_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

/** Tolerance for clock drift between this machine and Google, in seconds. */
const CLOCK_SKEW_SECONDS = 60;

/** Longest token we will even attempt to parse, as a cheap DoS guard. */
const MAX_TOKEN_LENGTH = 8192;

/** How long a stale cert set is trusted after a failed refresh, before retrying. */
const STALE_CERT_RETRY_MS = 60 * 1000;

/** In-memory cert cache: { keys: {kid: pem}, expiresAt: epochMillis }. */
let certCache = { keys: null, expiresAt: 0 };

/** Deduplicates concurrent cert fetches so a burst of requests makes one call. */
let certFetchInFlight = null;

/**
 * getProjectId — the Firebase project this server accepts tokens for.
 * Set FIREBASE_PROJECT_ID in .env; it must match the projectId in the
 * dashboard's firebaseConfig or every token will be rejected.
 */
function getProjectId() {
  return String(process.env.FIREBASE_PROJECT_ID || '').trim();
}

/**
 * getCuratorAllowlist — emails permitted to use the dashboard.
 * Set CURATOR_EMAILS in .env as a comma separated list. An empty list means
 * "any successfully authenticated Firebase user", which is only safe if you
 * have disabled self-registration in the Firebase console.
 */
function getCuratorAllowlist() {
  /* What this line does: Reads comma-separated email allowlist from CURATOR_EMAILS or ALLOWED_CURATOR_EMAILS */
  /* What it brings: Seamless support across different cloud provider variable naming patterns */
  /* Where changes can be seen: Backend curator authentication verification */
  const raw = process.env.CURATOR_EMAILS || process.env.ALLOWED_CURATOR_EMAILS || '';
  /* What this line does: Converts raw value to string, splits by commas, trims whitespace, lowercases, and discards empty values */
  /* What it brings: Normalizes email list so user email matching is robust and case-insensitive */
  /* Where changes can be seen: Authenticated curator check in verifyToken */
  return String(raw)
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** True when auth is fully configured and will actually be enforced. */
function isConfigured() {
  return Boolean(getProjectId());
}

/**
 * base64UrlDecode — decodes a JWT segment into a Buffer.
 *
 * @param {string} segment base64url encoded JWT part
 * @returns {Buffer}
 */
function base64UrlDecode(segment) {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

/**
 * fetchCerts — downloads and caches Google's signing certificates.
 * The cache honours the Cache-Control max-age Google sends, so we refresh
 * roughly once a day rather than on every request.
 *
 * @returns {Promise<Object>} Map of key id to PEM certificate
 */
async function fetchCerts() {
  if (certCache.keys && Date.now() < certCache.expiresAt) {
    return certCache.keys;
  }
  if (certFetchInFlight) return certFetchInFlight;

  certFetchInFlight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(CERT_URL, { signal: controller.signal });
      if (!res.ok) throw new Error('Certificate fetch failed with status ' + res.status);

      const keys = await res.json();
      if (!keys || typeof keys !== 'object' || !Object.keys(keys).length) {
        throw new Error('Certificate endpoint returned no keys.');
      }

      // Respect Google's cache lifetime, clamped to a sane window.
      const cacheControl = res.headers.get('cache-control') || '';
      const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
      const maxAgeSeconds = maxAgeMatch ? Math.min(Number(maxAgeMatch[1]), 86400) : 3600;

      certCache = { keys, expiresAt: Date.now() + maxAgeSeconds * 1000 };
      return keys;
    } catch (err) {
      // Google's certificates change roughly daily and the old ones stay valid
      // for a while after. A refresh that fails is not a reason to reject every
      // curator for as long as the outage lasts — the keys we already hold are
      // still the ones the tokens in circulation were signed with.
      if (certCache.keys) {
        console.warn('[auth] could not refresh Google certs, using the cached set:', err.message);
        // Try again on the next request rather than sitting on stale keys.
        certCache.expiresAt = Date.now() + STALE_CERT_RETRY_MS;
        return certCache.keys;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      certFetchInFlight = null;
    }
  })();

  return certFetchInFlight;
}

/**
 * authError — a refusal that says what the caller should do about it.
 *
 * The distinction is the whole point. "Your session lapsed" and "you are not a
 * curator" are both refusals, and both used to come back as 403; the dashboard
 * then showed a lapsed session as a permissions problem, telling a curator to
 * add themselves to CURATOR_EMAILS when all they had to do was sign in again.
 *
 *   reauth  — the token is the problem. Get a new one and try again (401).
 *   forbidden — the identity is the problem. A new token will not help (403).
 *
 * @param {string} message What to tell the person
 * @param {'reauth'|'forbidden'} kind
 */
function authError(message, kind) {
  const err = new Error(message);
  err.authKind = kind;
  err.statusCode = kind === 'reauth' ? 401 : 403;
  return err;
}

/**
 * verifyIdToken — full verification of a Firebase ID token.
 * Throws with a specific reason on any failure; returns the trusted identity
 * on success. Nothing in the token is trusted until the signature checks out.
 *
 * @param {string} token Raw JWT from the Authorization header
 * @returns {Promise<{uid: string, email: string, name: string, emailVerified: boolean}>}
 */
async function verifyIdToken(token) {
  const projectId = getProjectId();
  if (!projectId) {
    throw authError('FIREBASE_PROJECT_ID is not set — refusing to accept any token.', 'forbidden');
  }
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH) {
    throw authError('Malformed authentication token.', 'reauth');
  }

  const parts = token.split('.');
  if (parts.length !== 3) throw authError('Malformed authentication token.', 'reauth');

  let header;
  let claims;
  try {
    header = JSON.parse(base64UrlDecode(parts[0]).toString('utf8'));
    claims = JSON.parse(base64UrlDecode(parts[1]).toString('utf8'));
  } catch (err) {
    throw authError('Malformed authentication token.', 'reauth');
  }

  // Pin the algorithm. Without this an attacker could present alg:none or an
  // HMAC token signed with the (public) certificate as the key.
  if (header.alg !== 'RS256') throw authError('Unexpected token algorithm.', 'reauth');
  if (!header.kid) throw authError('Token is missing a key id.', 'reauth');

  const certs = await fetchCerts();
  const certPem = certs[header.kid];
  if (!certPem) throw authError('Token was signed with an unknown key.', 'reauth');

  const publicKey = new crypto.X509Certificate(certPem).publicKey;
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(parts[0] + '.' + parts[1]);
  verifier.end();

  if (!verifier.verify(publicKey, base64UrlDecode(parts[2]))) {
    throw authError('Token signature is invalid.', 'reauth');
  }

  // Signature is good — now the claims must match this project and be current.
  const now = Math.floor(Date.now() / 1000);

  if (claims.aud !== projectId) throw authError('Token was issued for a different project.', 'reauth');
  if (claims.iss !== 'https://securetoken.google.com/' + projectId) {
    throw authError('Token has an unexpected issuer.', 'reauth');
  }
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < now) {
    throw authError('Token has expired — sign in again.', 'reauth');
  }
  if (typeof claims.iat !== 'number' || claims.iat - CLOCK_SKEW_SECONDS > now) {
    throw authError('Token was issued in the future.', 'reauth');
  }
  if (typeof claims.auth_time === 'number' && claims.auth_time - CLOCK_SKEW_SECONDS > now) {
    throw authError('Token authentication time is in the future.', 'reauth');
  }
  if (!claims.sub || typeof claims.sub !== 'string') {
    throw authError('Token has no subject.', 'reauth');
  }

  return {
    uid: claims.sub,
    email: String(claims.email || '').toLowerCase(),
    name: String(claims.name || ''),
    emailVerified: Boolean(claims.email_verified),
    signInProvider: (claims.firebase && claims.firebase.sign_in_provider) || 'unknown'
  };
}

/**
 * authorize — verifies the token and applies the curator allowlist.
 *
 * @param {string} token Raw JWT
 * @returns {Promise<Object>} The authorized identity
 */
async function authorize(token) {
  const identity = await verifyIdToken(token);
  const allowlist = getCuratorAllowlist();

  if (allowlist.length > 0 && allowlist.indexOf(identity.email) === -1) {
    throw authError(
      'Account ' + (identity.email || identity.uid) + ' is not on the curator allowlist.', 'forbidden');
  }

  // An unverified email proves nothing about who is holding the account, so it
  // is refused whether or not there is an allowlist.
  //
  // Being ON the allowlist used to be treated as enough, and that was the hole:
  // anyone can register a Firebase password account for an address they do not
  // own, so an allowlisted address that had never actually signed in could
  // simply be claimed by a stranger. Google sign-in arrives verified, so this
  // costs a real curator nothing.
  if (!identity.emailVerified) {
    throw authError(
      'This account\'s email address is not verified. Sign in with Google, or verify the address.',
      'forbidden');
  }

  return identity;
}

/**
 * extractBearerToken — pulls the JWT out of an Authorization header.
 *
 * @param {http.IncomingMessage} req
 * @returns {string} The token, or '' when absent
 */
function extractBearerToken(req) {
  const header = req.headers['authorization'] || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : '';
}

/** A short description of the auth posture, for the health dashboard. */
function describeConfig() {
  const allowlist = getCuratorAllowlist();
  return {
    projectId: getProjectId() || null,
    enforced: isConfigured(),
    allowlistSize: allowlist.length,
    allowlistMode: allowlist.length > 0 ? 'allowlist' : 'any-verified-user'
  };
}

module.exports = {
  isConfigured,
  authError,
  authorize,
  verifyIdToken,
  extractBearerToken,
  describeConfig,
  getCuratorAllowlist,
  getProjectId
};

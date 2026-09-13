//
// Trusting the certificates this Mac already trusts.
//
// Node ships its own list of root certificates and ignores the system
// keychain entirely. On a managed machine the TLS-inspecting proxy's root —
// Netskope, Zscaler and friends — is installed in the keychain, so Safari and
// curl are perfectly happy while every https call from here dies with
// "self signed certificate in certificate chain".
//
// The answer is to hand Node the machine's roots *as well as* its own, not to
// turn verification off. An inspected connection is still verified; it is
// verified against the certificate your IT department put there on purpose.
//
// Zero dependencies: `security` is part of macOS.

const tls = require('tls');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const KEYCHAINS = [
  '/System/Library/Keychains/SystemRootCertificates.keychain',  // Apple's roots
  '/Library/Keychains/System.keychain',                         // what IT installed
  path.join(os.homedir(), 'Library/Keychains/login.keychain-db'), // and what you did
];

function pemsFrom(keychain) {
  let out = '';
  try {
    out = execFileSync('security', ['find-certificate', '-a', '-p', keychain],
      { encoding: 'utf8', maxBuffer: 32 << 20, timeout: 15000 });
  } catch { return []; }
  return out.split(/(?=-----BEGIN CERTIFICATE-----)/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith('-----BEGIN CERTIFICATE-----'));
}

function systemRoots() {
  const seen = new Set();
  const all = [];
  KEYCHAINS.forEach((k) => pemsFrom(k).forEach((pem) => {
    if (seen.has(pem)) return;
    seen.add(pem);
    all.push(pem);
  }));
  return all;
}

let installed = null;

// Returns what it did, so the app can say so rather than leaving you to guess
// why a network call fails in one place and not another.
function install() {
  if (installed) return installed;
  installed = { platform: process.platform, added: 0, total: tls.rootCertificates.length, ok: false };
  if (process.platform !== 'darwin') return installed;
  try {
    const extra = systemRoots();
    if (!extra.length) return installed;
    const bundled = new Set(tls.rootCertificates.map((c) => c.trim()));
    const added = extra.filter((c) => !bundled.has(c.trim()));
    if (!added.length) { installed.ok = true; return installed; }
    https.globalAgent.options.ca = [...tls.rootCertificates, ...added];
    installed.added = added.length;
    installed.total = tls.rootCertificates.length + added.length;
    installed.ok = true;
  } catch (e) {
    installed.error = String(e.message || e);
  }
  return installed;
}

module.exports = { install, systemRoots, status: () => installed };

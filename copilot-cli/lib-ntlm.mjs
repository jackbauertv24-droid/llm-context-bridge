// NTLMv2 authentication, enough of it to log in to an Exchange endpoint.
//
// The server this was built for answers a Basic attempt with
// "WWW-Authenticate: Negotiate, NTLM" and no Basic at all, so a password
// alone is not enough — it has to be used in the NTLM challenge/response
// handshake. The firm's own sf-processor gets this for free because
// ews-java-api runs on Apache HttpClient, which does NTLM under the covers
// with the very same username and password. This is that handshake, by hand.
//
// MD4 is implemented here rather than taken from node:crypto. OpenSSL 3
// moved it to the legacy provider, so crypto.createHash('md4') throws
// ERR_OSSL_EVP_UNSUPPORTED on any current node, and the NT hash is defined
// as MD4 of the UTF-16LE password. Everything else — HMAC-MD5, random bytes
// — comes from crypto.
//
// This implements NTLMv2 only. LM responses are not sent at all: they are
// the weak half of the protocol and no Exchange in service requires them.

import { createHmac, randomBytes } from 'node:crypto';

// ------------------------------------------------------------------- MD4
//
// RFC 1320. Written out in full because it is short, fixed forever, and
// checkable against published vectors — see selfTest() at the bottom.

const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;

export function md4(input) {
  const msg = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const bitLen = msg.length * 8;
  // Pad to 56 mod 64, then eight bytes of little-endian bit length.
  const padded = Buffer.alloc(((msg.length + 8) >> 6 << 6) + 64);
  msg.copy(padded);
  padded[msg.length] = 0x80;
  padded.writeUInt32LE(bitLen >>> 0, padded.length - 8);
  padded.writeUInt32LE(Math.floor(bitLen / 0x100000000), padded.length - 4);

  let [a, b, c, d] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];

  for (let off = 0; off < padded.length; off += 64) {
    const x = new Array(16);
    for (let i = 0; i < 16; i++) x[i] = padded.readUInt32LE(off + i * 4);
    const [aa, bb, cc, dd] = [a, b, c, d];

    // Round 1: F(x,y,z) = (x & y) | (~x & z)
    const f = (p, q, r) => (p & q) | (~p & r);
    const r1 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    const s1 = [3, 7, 11, 19];
    for (let i = 0; i < 16; i++) {
      const k = r1[i];
      const s = s1[i % 4];
      if (i % 4 === 0) a = rotl((a + f(b, c, d) + x[k]) >>> 0, s);
      else if (i % 4 === 1) d = rotl((d + f(a, b, c) + x[k]) >>> 0, s);
      else if (i % 4 === 2) c = rotl((c + f(d, a, b) + x[k]) >>> 0, s);
      else b = rotl((b + f(c, d, a) + x[k]) >>> 0, s);
    }

    // Round 2: G(x,y,z) = (x & y) | (x & z) | (y & z), constant 0x5a827999
    const g = (p, q, r) => (p & q) | (p & r) | (q & r);
    const r2 = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15];
    const s2 = [3, 5, 9, 13];
    for (let i = 0; i < 16; i++) {
      const k = r2[i];
      const s = s2[i % 4];
      if (i % 4 === 0) a = rotl((a + g(b, c, d) + x[k] + 0x5a827999) >>> 0, s);
      else if (i % 4 === 1) d = rotl((d + g(a, b, c) + x[k] + 0x5a827999) >>> 0, s);
      else if (i % 4 === 2) c = rotl((c + g(d, a, b) + x[k] + 0x5a827999) >>> 0, s);
      else b = rotl((b + g(c, d, a) + x[k] + 0x5a827999) >>> 0, s);
    }

    // Round 3: H(x,y,z) = x ^ y ^ z, constant 0x6ed9eba1
    const h = (p, q, r) => p ^ q ^ r;
    const r3 = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
    const s3 = [3, 9, 11, 15];
    for (let i = 0; i < 16; i++) {
      const k = r3[i];
      const s = s3[i % 4];
      if (i % 4 === 0) a = rotl((a + h(b, c, d) + x[k] + 0x6ed9eba1) >>> 0, s);
      else if (i % 4 === 1) d = rotl((d + h(a, b, c) + x[k] + 0x6ed9eba1) >>> 0, s);
      else if (i % 4 === 2) c = rotl((c + h(d, a, b) + x[k] + 0x6ed9eba1) >>> 0, s);
      else b = rotl((b + h(c, d, a) + x[k] + 0x6ed9eba1) >>> 0, s);
    }

    a = (a + aa) >>> 0; b = (b + bb) >>> 0; c = (c + cc) >>> 0; d = (d + dd) >>> 0;
  }

  const out = Buffer.alloc(16);
  out.writeUInt32LE(a, 0); out.writeUInt32LE(b, 4);
  out.writeUInt32LE(c, 8); out.writeUInt32LE(d, 12);
  return out;
}

// ------------------------------------------------------------- NTLM bits

const utf16 = (s) => Buffer.from(String(s), 'utf16le');
const SIGNATURE = Buffer.from('NTLMSSP\0', 'latin1');

// Only the flags this exchange needs. No signing or sealing is negotiated:
// HTTP authentication does not use them, and asking for them would oblige us
// to implement session security we would never exercise.
const FLAGS = {
  NEGOTIATE_UNICODE: 0x00000001,
  REQUEST_TARGET: 0x00000004,
  NEGOTIATE_NTLM: 0x00000200,
  NEGOTIATE_ALWAYS_SIGN: 0x00008000,
  NEGOTIATE_EXTENDED_SESSIONSECURITY: 0x00080000,
  NEGOTIATE_128: 0x20000000,
  NEGOTIATE_56: 0x80000000,
};

const TYPE1_FLAGS = (FLAGS.NEGOTIATE_UNICODE | FLAGS.REQUEST_TARGET
  | FLAGS.NEGOTIATE_NTLM | FLAGS.NEGOTIATE_ALWAYS_SIGN
  | FLAGS.NEGOTIATE_EXTENDED_SESSIONSECURITY | FLAGS.NEGOTIATE_128
  | FLAGS.NEGOTIATE_56) >>> 0;

/** Split DOMAIN\user, or user@domain, into its parts. */
export function splitUser(user) {
  const s = String(user || '');
  const slash = s.indexOf('\\');
  if (slash > 0) return { domain: s.slice(0, slash), user: s.slice(slash + 1) };
  const at = s.indexOf('@');
  if (at > 0) return { domain: s.slice(at + 1), user: s.slice(0, at) };
  return { domain: '', user: s };
}

/** The opening message: "I would like to use NTLM, here is what I support." */
export function createType1Message() {
  const msg = Buffer.alloc(32);
  SIGNATURE.copy(msg, 0);
  msg.writeUInt32LE(1, 8);
  msg.writeUInt32LE(TYPE1_FLAGS, 12);
  // Domain and workstation are sent empty and supplied by the server's
  // target info in type 3, which is what modern clients do.
  msg.writeUInt16LE(0, 16); msg.writeUInt16LE(0, 18); msg.writeUInt32LE(32, 20);
  msg.writeUInt16LE(0, 24); msg.writeUInt16LE(0, 26); msg.writeUInt32LE(32, 28);
  return msg;
}

/** The server's challenge: an 8-byte nonce plus the target information. */
export function parseType2Message(base64) {
  const buf = Buffer.from(String(base64), 'base64');
  if (buf.length < 32 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('the server sent something that is not an NTLM challenge');
  }
  if (buf.readUInt32LE(8) !== 2) throw new Error('expected an NTLM type 2 message');
  const flags = buf.readUInt32LE(20);
  const challenge = buf.subarray(24, 32);

  let targetInfo = Buffer.alloc(0);
  if (buf.length >= 48) {
    const len = buf.readUInt16LE(40);
    const off = buf.readUInt32LE(44);
    if (len && off + len <= buf.length) targetInfo = buf.subarray(off, off + len);
  }
  let targetName = '';
  const tnLen = buf.readUInt16LE(12);
  const tnOff = buf.readUInt32LE(16);
  if (tnLen && tnOff + tnLen <= buf.length) {
    targetName = buf.subarray(tnOff, tnOff + tnLen).toString('utf16le');
  }
  return { flags, challenge, targetInfo, targetName };
}

/**
 * Windows counts 100-nanosecond intervals since 1601. The blob carries one,
 * and a server may reject a response whose timestamp is far out.
 */
function windowsTime(date = new Date()) {
  const ticks = BigInt(date.getTime() + 11644473600000) * 10000n;
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(ticks);
  return out;
}

/**
 * The NTLMv2 response.
 *
 *   NT hash     = MD4(UTF16LE(password))
 *   NTLMv2 hash = HMAC-MD5(NT hash, UTF16LE(UPPER(user) + domain))
 *   response    = HMAC-MD5(NTLMv2 hash, challenge + blob) + blob
 *
 * The domain is upper-cased in the hash only when the server told us one;
 * the user name always is. This is the detail that most hand-written
 * implementations get wrong, and it fails as a plain 401 with no clue.
 */
export function ntlmv2Response({ user, domain, password, challenge, targetInfo, time = windowsTime(), clientNonce = randomBytes(8) }) {
  const ntHash = md4(utf16(password));
  const identity = utf16(String(user).toUpperCase() + String(domain || ''));
  const ntlmv2Hash = createHmac('md5', ntHash).update(identity).digest();

  const blob = Buffer.concat([
    Buffer.from([0x01, 0x01, 0x00, 0x00]),      // blob signature and reserved
    Buffer.alloc(4),                            // reserved
    time,
    clientNonce,
    Buffer.alloc(4),                            // unknown, zero
    targetInfo,
    Buffer.alloc(4),                            // terminator
  ]);

  const proof = createHmac('md5', ntlmv2Hash)
    .update(Buffer.concat([challenge, blob]))
    .digest();

  return Buffer.concat([proof, blob]);
}

/** The final message, carrying the response the server will verify. */
export function createType3Message({ user, domain, password, workstation = 'WORKSTATION', type2 }) {
  const targetDomain = domain || type2.targetName || '';
  const ntResponse = ntlmv2Response({
    user, domain: targetDomain, password,
    challenge: type2.challenge, targetInfo: type2.targetInfo,
  });

  const domainBytes = utf16(targetDomain);
  const userBytes = utf16(user);
  const hostBytes = utf16(workstation);
  // An empty LM response: NTLMv2 makes it pointless and sending a real one
  // would only weaken the exchange.
  const lmResponse = Buffer.alloc(24);

  const base = 64;
  const offsets = {};
  let at = base;
  for (const [name, buf] of [['lm', lmResponse], ['nt', ntResponse], ['domain', domainBytes], ['user', userBytes], ['host', hostBytes]]) {
    offsets[name] = { off: at, len: buf.length, buf };
    at += buf.length;
  }

  const msg = Buffer.alloc(at);
  SIGNATURE.copy(msg, 0);
  msg.writeUInt32LE(3, 8);

  const field = (pos, { off, len }) => {
    msg.writeUInt16LE(len, pos);
    msg.writeUInt16LE(len, pos + 2);
    msg.writeUInt32LE(off, pos + 4);
  };
  field(12, offsets.lm);
  field(20, offsets.nt);
  field(28, offsets.domain);
  field(36, offsets.user);
  field(44, offsets.host);
  // Session key: not negotiated, so empty.
  msg.writeUInt16LE(0, 52); msg.writeUInt16LE(0, 54); msg.writeUInt32LE(at, 56);
  msg.writeUInt32LE(TYPE1_FLAGS, 60);

  for (const { off, buf } of Object.values(offsets)) buf.copy(msg, off);
  return msg;
}

/**
 * Checks the primitives against published vectors.
 *
 * MD4 is written out by hand here, so it gets verified rather than trusted:
 * a wrong MD4 produces a valid-looking handshake that simply never
 * authenticates, which is indistinguishable from a wrong password.
 */
export function selfTest() {
  const checks = [
    ['md4("")', md4(Buffer.alloc(0)).toString('hex'), '31d6cfe0d16ae931b73c59d7e0c089c0'],
    ['md4("abc")', md4('abc').toString('hex'), 'a448017aaf21d8525fc10ae87aa6729d'],
    ['md4("message digest")', md4('message digest').toString('hex'), 'd9130a8164549fe818874806e1c7014b'],
    ['md4(a..z)', md4('abcdefghijklmnopqrstuvwxyz').toString('hex'), 'd79e1c308aa5bbcdeea8ed63df412da9'],
    // The NT hash of "password", the standard NTLM worked example.
    ['NT hash of "password"', md4(utf16('password')).toString('hex'), '8846f7eaee8fb117ad06bdd830b7586c'],
    // MS-NLMP 4.2.4.1.1: user "User", domain "Domain", password "Password".
    ['NTLMv2 hash (MS-NLMP)',
      createHmac('md5', md4(utf16('Password'))).update(utf16('USER' + 'Domain')).digest().toString('hex'),
      '0c868a403bfd7a93a3001ef22ef02e3f'],
  ];
  const failures = checks.filter(([, got, want]) => got !== want);
  return { ok: failures.length === 0, checks, failures };
}

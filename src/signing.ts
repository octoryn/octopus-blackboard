import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";

/**
 * Minimal session signing (v0). Each session gets an Ed25519 keypair; the
 * private key stays local (never leaves the machine), the public key is
 * recorded on the session. Signing the timeline head hash lets `verify` show
 * whether board state is vouched for by a key — i.e. trusted vs. merely
 * asserted. This is deliberately NOT a full identity/PKI system: no key
 * distribution, revocation, or web-of-trust yet.
 */

export interface SessionKeypair {
  publicKeyPem: string;
  privateKeyPem: string;
}

export function generateSessionKeypair(): SessionKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
  };
}

/** Sign a hex hash string with a PEM private key; returns base64. */
export function signHash(privateKeyPem: string, hash: string): string {
  const key = createPrivateKey(privateKeyPem);
  return sign(null, Buffer.from(hash), key).toString("base64");
}

/** Verify a base64 signature over a hash against a PEM public key. */
export function verifyHash(
  publicKeyPem: string,
  hash: string,
  signatureB64: string,
): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return verify(
      null,
      Buffer.from(hash),
      key,
      Buffer.from(signatureB64, "base64"),
    );
  } catch {
    return false;
  }
}

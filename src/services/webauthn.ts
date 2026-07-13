import crypto from "crypto";

interface WebAuthnCredential {
  id: string;
  publicKey: string;
  name: string;
  createdAt: string;
}

function decodeCbor(buf: Buffer): { value: any; rest: Buffer } {
  if (buf.length === 0) throw new Error("Empty CBOR input");
  const major = buf[0] >> 5;
  const additional = buf[0] & 0x1f;
  let offset = 1;
  let value: any;
  let len = 0;

  if (additional < 24) {
    len = additional;
  } else if (additional === 24) {
    len = buf[1];
    offset = 2;
  } else if (additional === 25) {
    len = buf.readUInt16BE(1);
    offset = 3;
  } else if (additional === 26) {
    len = buf.readUInt32BE(1);
    offset = 5;
  } else if (additional === 27) {
    const high = buf.readUInt32BE(1);
    const low = buf.readUInt32BE(5);
    len = high * 0x100000000 + low;
    offset = 9;
  }

  switch (major) {
    case 0: // unsigned integer
      value = len;
      break;
    case 1: // negative integer
      value = -1 - len;
      break;
    case 2: // byte string
      value = buf.subarray(offset, offset + len);
      offset += len;
      break;
    case 3: // text string
      value = buf.subarray(offset, offset + len).toString("utf-8");
      offset += len;
      break;
    case 4: // array
      value = [];
      for (let i = 0; i < len; i++) {
        const item = decodeCbor(buf.subarray(offset));
        value.push(item.value);
        offset += buf.length - offset - item.rest.length;
      }
      break;
    case 5: { // map
      value = new Map<number, any>();
      for (let i = 0; i < len; i++) {
        const key = decodeCbor(buf.subarray(offset));
        offset += buf.length - offset - key.rest.length;
        const val = decodeCbor(buf.subarray(offset));
        offset += buf.length - offset - val.rest.length;
        value.set(key.value, val.value);
      }
      break;
    }
    default:
      throw new Error(`Unsupported CBOR major type: ${major}`);
  }

  return { value, rest: buf.subarray(offset) };
}

function coseKeyToJwk(key: Map<number, any>): any {
  const kty = key.get(1);
  const alg = key.get(3);
  const crv = key.get(-1);
  const x = key.get(-2);
  const y = key.get(-3);

  if (kty !== 2) throw new Error("Only EC2 keys supported");
  if (alg !== -7) throw new Error("Only ES256 algorithm supported");
  if (crv !== 1) throw new Error("Only P-256 curve supported");

  const xBuf = Buffer.isBuffer(x) ? x : Buffer.from(x);
  const yBuf = Buffer.isBuffer(y) ? y : Buffer.from(y);

  return {
    kty: "EC",
    crv: "P-256",
    x: xBuf.toString("base64url"),
    y: yBuf.toString("base64url"),
  };
}

export function generateChallenge(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function encodeBase64Url(str: string): string {
  return Buffer.from(str).toString("base64url");
}

export function decodeBase64Url(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

export function generateRegistrationOptions(challenge: string, rpName: string, rpId: string, userId: string, userName: string, userDisplayName: string, existingCredentials: WebAuthnCredential[]): any {

  const excludeCredentials = existingCredentials.map((cred) => ({
    type: "public-key",
    id: cred.id,
  }));

  return {
    challenge: encodeBase64Url(challenge),
    rp: { name: rpName, id: rpId },
    user: {
      id: encodeBase64Url(userId),
      name: userName,
      displayName: userDisplayName,
    },
    pubKeyCredParams: [
      { type: "public-key", alg: -7 },   // ES256
      { type: "public-key", alg: -257 }, // RS256
    ],
    timeout: 60000,
    attestation: "none" as const,
    excludeCredentials: excludeCredentials.length > 0 ? excludeCredentials : undefined,
    authenticatorSelection: {
      authenticatorAttachment: "cross-platform",
      userVerification: "preferred",
    },
  };
}

export function verifyAttestation(clientDataJSON: string, attestationObject: string, challenge: string, rpId: string, origin: string): { credentialId: string; publicKey: string } {
  const clientData = JSON.parse(decodeBase64Url(clientDataJSON).toString("utf-8"));

  if (clientData.challenge !== challenge) {
    throw new Error("Challenge mismatch");
  }
  if (clientData.type !== "webauthn.create") {
    throw new Error("Invalid client data type");
  }
  if (clientData.origin !== origin) {
    throw new Error(`Origin mismatch: server=${origin}, client=${clientData.origin}`);
  }

  const clientDataHash = crypto.createHash("sha256").update(decodeBase64Url(clientDataJSON)).digest();

  const attObjBuf = decodeBase64Url(attestationObject);
  const { value: attObj } = decodeCbor(attObjBuf);

  const fmt = attObj.get("fmt");
  const attStmt = attObj.get("attStmt");
  const authData = attObj.get("authData") as Buffer;

  if (fmt !== "none" && fmt !== "packed") {
    throw new Error(`Unsupported attestation format: ${fmt}`);
  }

  // Parse authData
  const rpIdHash = authData.subarray(0, 32);
  const expectedRpIdHash = crypto.createHash("sha256").update(rpId).digest();
  if (!rpIdHash.equals(expectedRpIdHash)) {
    throw new Error("RP ID hash mismatch");
  }

  const flags = authData[32];
  const userPresent = (flags & 0x01) !== 0;
  const userVerified = (flags & 0x04) !== 0;
  const attestedData = (flags & 0x40) !== 0;

  if (!userPresent && !userVerified) {
    throw new Error("User not present or verified");
  }

  if (!attestedData) {
    throw new Error("Attested credential data not present");
  }

  let offset = 37;
  offset += 16; // skip AAGUID

  const credentialIdLength = authData.readUInt16BE(offset);
  offset += 2;

  const credentialId = authData.subarray(offset, offset + credentialIdLength);
  const credentialIdB64 = credentialId.toString("base64url");
  offset += credentialIdLength;

  const credentialPublicKeyCbor = authData.subarray(offset);
  const { value: coseKey } = decodeCbor(credentialPublicKeyCbor);

  const publicKeyJwk = coseKeyToJwk(coseKey);
  const pubKeyObj = crypto.createPublicKey({ key: publicKeyJwk, format: "jwk" });

  // Verify attestation signature if format is "packed"
  if (fmt === "packed") {
    const sig = attStmt.get("sig") as Buffer;
    const alg = attStmt.get("alg") as number;

    if (alg !== -7) {
      throw new Error(`Unsupported attestation algorithm: ${alg}`);
    }

    const verificationData = Buffer.concat([authData, clientDataHash]);

    const verify = crypto.createVerify("SHA256");
    verify.update(verificationData);
    verify.end();

    if (!verify.verify(pubKeyObj, sig)) {
      throw new Error("Attestation signature verification failed");
    }
  }

  return {
    credentialId: credentialIdB64,
    publicKey: JSON.stringify(publicKeyJwk),
  };
}

export function generateAssertionOptions(challenge: string, rpId: string, credentials: WebAuthnCredential[]): any {
  const allowCredentials = credentials.map((cred) => ({
    type: "public-key",
    id: cred.id,
  }));

  return {
    challenge: encodeBase64Url(challenge),
    rpId,
    allowCredentials,
    timeout: 60000,
    userVerification: "preferred",
  };
}

export function verifyAssertion(clientDataJSON: string, authenticatorData: string, signature: string, challenge: string, credentialId: string, publicKeyBase64: string, origin: string, rpId: string): boolean {
  const clientDataRaw = decodeBase64Url(clientDataJSON).toString("utf-8");
  let clientData;
  try {
    clientData = JSON.parse(clientDataRaw);
  } catch {
    throw new Error("Failed to parse clientDataJSON");
  }

  if (clientData.challenge !== challenge) {
    throw new Error(`Challenge mismatch: server=${challenge.substring(0, 20)}..., client=${clientData.challenge?.substring(0, 20)}...`);
  }
  if (clientData.type !== "webauthn.get") {
    throw new Error(`Invalid client data type: ${clientData.type}`);
  }
  if (clientData.origin !== origin) {
    throw new Error(`Origin mismatch: server=${origin}, client=${clientData.origin}`);
  }

  const clientDataHash = crypto.createHash("sha256").update(decodeBase64Url(clientDataJSON)).digest();
  const authDataBuf = decodeBase64Url(authenticatorData);
  const sigBuf = decodeBase64Url(signature);

  const rpIdHash = authDataBuf.subarray(0, 32);
  const expectedRpIdHash = crypto.createHash("sha256").update(rpId).digest();
  if (!rpIdHash.equals(expectedRpIdHash)) {
    throw new Error("RP ID hash mismatch");
  }

  const flags = authDataBuf[32];
  if (!(flags & 0x01)) {
    throw new Error("User not present");
  }

  const verificationData = Buffer.concat([authDataBuf, clientDataHash]);

  let pubKeyObj;
  try {
    const publicKeyJwk = JSON.parse(publicKeyBase64);
    pubKeyObj = crypto.createPublicKey({ key: publicKeyJwk, format: "jwk" });
  } catch (e: any) {
    throw new Error(`Failed to create public key: ${e.message}`, { cause: e });
  }

  const verify = crypto.createVerify("SHA256");
  verify.update(verificationData);
  verify.end();

  if (!verify.verify(pubKeyObj, sigBuf)) {
    throw new Error("Signature verification failed");
  }

  return true;
}

export function generateQRDataUri(text: string): string {
  // Generate a simple SVG QR-like representation or use a data URI.
  // Return the Google Charts API URL for QR code generation.
  const encoded = encodeURIComponent(text);
  return `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encoded}`;
}

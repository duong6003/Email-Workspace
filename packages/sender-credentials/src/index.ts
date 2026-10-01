import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

export function parseSenderCredentialKey(value: string | undefined): Buffer {
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error('SENDER_CREDENTIAL_KEY must contain exactly 64 hexadecimal characters.');
  }
  return Buffer.from(value, 'hex');
}

function additionalData(tenantId: string, secretRef: string): Buffer {
  return Buffer.from(`${tenantId}:${secretRef}`, 'utf8');
}

export function encryptSenderSecret(key: Buffer, tenantId: string, secretRef: string, secret: string): string {
  const initializationVector = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, initializationVector);
  cipher.setAAD(additionalData(tenantId, secretRef));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [VERSION, initializationVector.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decryptSenderSecret(key: Buffer, tenantId: string, secretRef: string, value: string): string {
  const [version, initializationVector, authenticationTag, ciphertext] = value.split(':');
  if (version !== VERSION || !initializationVector || !authenticationTag || !ciphertext) {
    throw new Error('Unsupported sender credential ciphertext.');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(initializationVector, 'base64'));
  decipher.setAAD(additionalData(tenantId, secretRef));
  decipher.setAuthTag(Buffer.from(authenticationTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

export function resolveSenderSecret(input: {
  tenantId: string;
  secretRef: string;
  ciphertext?: string | null;
  environment?: NodeJS.ProcessEnv;
  credentialKey?: string;
}): string | undefined {
  const legacySecret = (input.environment ?? process.env)[input.secretRef];
  if (legacySecret !== undefined) return legacySecret;
  if (!input.ciphertext) return undefined;
  return decryptSenderSecret(parseSenderCredentialKey(input.credentialKey ?? process.env.SENDER_CREDENTIAL_KEY), input.tenantId, input.secretRef, input.ciphertext);
}

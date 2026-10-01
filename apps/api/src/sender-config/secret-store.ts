export interface SecretStore {
  put(reference: string, secret: string): Promise<void>;
  resolve(reference: string): Promise<string | undefined>;
}

/** Local-only seam; production can replace this provider with a real secret manager. */
export class EnvSecretStore implements SecretStore {
  private readonly values = new Map<string, string>();
  async put(reference: string, secret: string): Promise<void> { this.values.set(reference, secret); }
  async resolve(reference: string): Promise<string | undefined> { return this.values.get(reference) ?? process.env[reference]; }
}

export function maskSecretReference(reference: string): string {
  return reference.length <= 4 ? '••••' : `${reference.slice(0, 2)}••••${reference.slice(-2)}`;
}

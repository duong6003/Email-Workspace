import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../packages/api-schematics/', import.meta.url));
const destination = fileURLToPath(new URL('../packages/api-schematics/dist/tenant-module/', import.meta.url));
mkdirSync(destination, { recursive: true });
cpSync(`${root}src/tenant-module/files`, `${destination}files`, { recursive: true });
cpSync(`${root}src/tenant-module/integration-files`, `${destination}integration-files`, { recursive: true });

import { SchematicTestRunner } from '@angular-devkit/schematics/testing/index.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const rawArguments = process.argv.slice(2);
if (rawArguments[0] === '--') rawArguments.shift();
const [name, entity, entityPath, readPermission, managePermission] = rawArguments;
if (!name || !entity || !entityPath) {
  console.error('usage: pnpm generate:api-module -- <kebab-name> <EntityNameEntity> <entity-path> [READ_PERMISSION] [MANAGE_PERMISSION]');
  process.exit(2);
}

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const outputRoot = resolve(process.cwd());
const runner = new SchematicTestRunner(
  '@eow/api-schematics',
  resolve(repositoryRoot, 'packages/api-schematics/collection.json'),
);
const tree = await runner.runSchematic('tenant-module', {
  name,
  entity,
  entityPath,
  ...(readPermission ? { readPermission } : {}),
  ...(managePermission ? { managePermission } : {}),
});

const outputs = tree.files.map((treePath) => {
  const relativePath = treePath.replace(/^\/+/, '');
  const destination = resolve(outputRoot, relativePath);
  if (destination !== outputRoot && !destination.startsWith(`${outputRoot}${sep}`)) {
    throw new Error(`Schematic attempted to write outside the workspace: ${treePath}`);
  }
  if (existsSync(destination)) throw new Error(`Refusing to overwrite existing file: ${destination}`);
  const content = tree.read(treePath);
  if (!content) throw new Error(`Schematic produced an unreadable file: ${treePath}`);
  return { destination, content };
});

for (const { destination, content } of outputs) {
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content, { flag: 'wx' });
}

console.log(`Generated ${outputs.length} files with @eow/api-schematics.`);

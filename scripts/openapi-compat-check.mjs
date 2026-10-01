#!/usr/bin/env node
// Fails if a new OpenAPI document breaks backward compatibility with an old one.
//
// contracts/openapi.yaml may only grow: existing paths, operations, required
// responses and required schema properties must stay present. Removing or
// narrowing any of them requires a superseding ADR (AGENTS.md section 5), not
// a silent edit — this is the CI gate for that rule.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';

function checkPaths(oldDoc, newDoc, breaks) {
  const oldPaths = oldDoc.paths ?? {};
  const newPaths = newDoc.paths ?? {};
  for (const [path, oldMethods] of Object.entries(oldPaths)) {
    const newMethods = newPaths[path];
    if (!newMethods) {
      breaks.push(`path removed: ${path}`);
      continue;
    }
    for (const [method, oldOp] of Object.entries(oldMethods)) {
      const newOp = newMethods[method];
      if (!newOp) {
        breaks.push(`operation removed: ${method.toUpperCase()} ${path}`);
        continue;
      }
      checkResponses(path, method, oldOp, newOp, breaks);
    }
  }
}

function checkResponses(path, method, oldOp, newOp, breaks) {
  const oldResponses = oldOp.responses ?? {};
  const newResponses = newOp.responses ?? {};
  for (const status of Object.keys(oldResponses)) {
    if (!(status in newResponses)) {
      breaks.push(`response removed: ${method.toUpperCase()} ${path} -> ${status}`);
    }
  }
}

function checkSchemas(oldDoc, newDoc, breaks) {
  const oldSchemas = oldDoc.components?.schemas ?? {};
  const newSchemas = newDoc.components?.schemas ?? {};
  for (const [name, oldSchema] of Object.entries(oldSchemas)) {
    const newSchema = newSchemas[name];
    if (!newSchema) {
      breaks.push(`schema removed: ${name}`);
      continue;
    }
    const oldRequired = new Set(oldSchema.required ?? []);
    const newRequired = new Set(newSchema.required ?? []);
    for (const field of oldRequired) {
      if (!newRequired.has(field)) {
        breaks.push(`required property removed: ${name}.${field}`);
      }
    }
  }
}

/**
 * An enum is a promise about the values a client may receive. Removing one is a
 * narrowing exactly like dropping a required property, so it belongs to the
 * same "may only grow" rule. Nodes are aligned by key path (array members by
 * index), which is why a deliberate reordering of an allOf list reads as a
 * change here — keep allOf order stable.
 */
function checkEnums(oldNode, newNode, breaks, path) {
  if (!oldNode || typeof oldNode !== 'object' || !newNode || typeof newNode !== 'object') return;
  if (Array.isArray(oldNode.enum) && Array.isArray(newNode.enum)) {
    const kept = new Set(newNode.enum);
    const removed = oldNode.enum.filter((value) => !kept.has(value));
    if (removed.length > 0) breaks.push(`enum values removed: ${path} -> ${removed.join(', ')}`);
  }
  for (const [key, oldChild] of Object.entries(oldNode)) {
    if (key === 'enum' || !oldChild || typeof oldChild !== 'object') continue;
    const newChild = newNode[key];
    if (!newChild || typeof newChild !== 'object') continue;
    checkEnums(oldChild, newChild, breaks, `${path}.${key}`);
  }
}

const DEFAULT_SPEC = 'contracts/openapi.yaml';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Called with no arguments, the check answers the question an agent actually has
 * before committing a contract edit: is what I changed in the working tree still
 * additive against what is already committed? Returns null when there is no
 * committed baseline at all (not a git repo, no HEAD yet, spec untracked), which
 * main() then treats exactly like a missing <old.yaml>.
 */
function baselineFromHead(tempDir) {
  let repoRoot;
  try {
    repoRoot = git(['rev-parse', '--show-toplevel']).trim();
  } catch {
    return null;
  }
  let committed;
  try {
    committed = git(['show', `HEAD:${DEFAULT_SPEC}`], repoRoot);
  } catch {
    return null;
  }
  const oldPath = join(tempDir, 'openapi-head.yaml');
  writeFileSync(oldPath, committed);
  return { oldPath, newPath: join(repoRoot, DEFAULT_SPEC) };
}

function compare(oldPath, newPath) {
  if (!existsSync(oldPath)) {
    console.log(`no previous spec at ${oldPath}; nothing to compare, treating as compatible`);
    return 0;
  }

  const oldDoc = load(readFileSync(oldPath, 'utf8'));
  const newDoc = load(readFileSync(newPath, 'utf8'));

  const breaks = [];
  checkPaths(oldDoc, newDoc, breaks);
  checkSchemas(oldDoc, newDoc, breaks);
  checkEnums(oldDoc.components?.schemas ?? {}, newDoc.components?.schemas ?? {}, breaks, 'components.schemas');
  checkEnums(oldDoc.paths ?? {}, newDoc.paths ?? {}, breaks, 'paths');

  if (breaks.length > 0) {
    console.error('Breaking OpenAPI changes detected:');
    for (const item of breaks) console.error(`  - ${item}`);
    console.error(
      '\ncontracts/openapi.yaml may only grow. Add a superseding ADR if this narrowing is intentional (AGENTS.md section 5).',
    );
    return 1;
  }

  console.log('No breaking OpenAPI changes detected.');
  return 0;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 0 && args.length !== 2) {
    console.error('usage: openapi-compat-check.mjs [<old.yaml> <new.yaml>]');
    console.error(`  with no arguments: compares HEAD:${DEFAULT_SPEC} against the working tree`);
    return 2;
  }
  if (args.length === 2) return compare(args[0], args[1]);

  const tempDir = mkdtempSync(join(tmpdir(), 'openapi-compat-'));
  try {
    const baseline = baselineFromHead(tempDir);
    if (!baseline) {
      console.log(`no committed ${DEFAULT_SPEC}; nothing to compare, treating as compatible`);
      return 0;
    }
    return compare(baseline.oldPath, baseline.newPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

process.exit(main());

import { strings } from '@angular-devkit/core';
import { apply, applyTemplates, chain, mergeWith, move, type Rule, url } from '@angular-devkit/schematics';

export type TenantModuleOptions = {
  name: string;
  entity: string;
  entityPath: string;
  readPermission?: string;
  managePermission?: string;
  path?: string;
};

export function tenantModule(options: TenantModuleOptions): Rule {
  if (!/^[a-z][a-z0-9-]*$/.test(options.name)) throw new Error('name must be kebab-case');
  if (!/^[A-Z][A-Za-z0-9]*Entity$/.test(options.entity)) throw new Error('entity must end in Entity');
  if (!/^[a-z0-9/-]+$/.test(options.entityPath)) throw new Error('entityPath must be a relative kebab-case path');
  const templateOptions = {
    ...strings,
    ...options,
    readPermission: options.readPermission ?? 'RECIPIENT_READ',
    managePermission: options.managePermission ?? 'RECIPIENT_MANAGE',
  };
  const moduleSource = apply(url('./files'), [
    applyTemplates({
      ...templateOptions,
    }),
    move(`${options.path ?? 'apps/api/src'}/${options.name}`),
  ]);
  const integrationSource = apply(url('./integration-files'), [
    applyTemplates({ ...templateOptions }),
    move('apps/api/test/integration'),
  ]);
  return chain([mergeWith(moduleSource), mergeWith(integrationSource)]);
}

import { describe, expect, it } from 'vitest';
import { computeVersionUpdatePrompt, pickLatestVersion, type TemplateVersionRef } from './template-version-pin.js';

describe('pickLatestVersion', () => {
  it('returns null for an empty list', () => {
    expect(pickLatestVersion([])).toBeNull();
  });

  it('returns the entry with the highest version number, regardless of array order', () => {
    const v1: TemplateVersionRef = { id: 'a', version: 1 };
    const v3: TemplateVersionRef = { id: 'c', version: 3 };
    const v2: TemplateVersionRef = { id: 'b', version: 2 };
    expect(pickLatestVersion([v1, v3, v2])).toBe(v3);
  });

  it('does not assume the list is pre-sorted -- listTemplateVersions happens to return DESC order today, but this function must not depend on that', () => {
    const v5: TemplateVersionRef = { id: 'z', version: 5 };
    const v1: TemplateVersionRef = { id: 'a', version: 1 };
    expect(pickLatestVersion([v1, v5])).toBe(v5);
  });
});

describe('computeVersionUpdatePrompt (BR-TPL-012: never auto-switch, only report)', () => {
  it('reports no update available when the pinned version is already the latest', () => {
    const versions: TemplateVersionRef[] = [{ id: 'v1', version: 1 }, { id: 'v2', version: 2 }];
    expect(computeVersionUpdatePrompt('v2', versions)).toEqual({ available: false });
  });

  it('reports the latest version when it differs from the pinned one', () => {
    const versions: TemplateVersionRef[] = [{ id: 'v1', version: 1 }, { id: 'v2', version: 2 }, { id: 'v4', version: 4 }];
    expect(computeVersionUpdatePrompt('v1', versions)).toEqual({ available: true, latest: { id: 'v4', version: 4 } });
  });

  it('reports no update available for an empty version list -- covers an archived template or a fetch that came back empty, so the screen never crashes or dangles a broken prompt', () => {
    expect(computeVersionUpdatePrompt('v1', [])).toEqual({ available: false });
  });

  it('still surfaces the real latest version even if the pinned id is not found in the list -- a defensive edge case, not one the API is expected to produce', () => {
    const versions: TemplateVersionRef[] = [{ id: 'v9', version: 9 }];
    expect(computeVersionUpdatePrompt('missing-id', versions)).toEqual({ available: true, latest: { id: 'v9', version: 9 } });
  });
});

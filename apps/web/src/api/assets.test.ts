import { afterEach, describe, expect, it, vi } from 'vitest';
import { archiveAsset, listAssets, replaceAsset, uploadAsset } from './assets.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngFile(name = 'logo.png'): File {
  return new File([PNG], name, { type: 'image/png' });
}

function assetBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'asset-1',
    url: 'https://app.example.test/api/v1/assets/asset-1/logo.png',
    filename: 'logo.png',
    contentType: 'image/png',
    byteSize: PNG.length,
    width: null,
    height: null,
    createdBy: null,
    createdByName: null,
    archivedAt: null,
    createdAt: '2026-09-03T00:00:00.000Z',
    ...overrides,
  };
}

/** The second argument every one of these clients hands `fetch`. */
function initOf(mock: ReturnType<typeof vi.spyOn>, call = 0): RequestInit {
  return mock.mock.calls[call]?.[1] as RequestInit;
}

describe('asset library client (MC-UI-005, ADR-043)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lists the tenant library over the session cookie', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ items: [assetBody()] }), { status: 200 }));

    await expect(listAssets()).resolves.toMatchObject({ items: [{ id: 'asset-1', contentType: 'image/png' }] });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/assets'), { credentials: 'include' });
  });

  it('uploads as multipart under the field the API reads, and never writes content-type itself', async () => {
    vi.stubGlobal('document', { cookie: 'eow_csrf=csrf-token' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(assetBody()), { status: 201 }));

    await expect(uploadAsset(pngFile())).resolves.toMatchObject({ id: 'asset-1' });

    const init = initOf(fetchMock);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(init.body).toBeInstanceOf(FormData);
    // FileInterceptor('file', ...) reads exactly this field name.
    expect((init.body as FormData).get('file')).toBeInstanceOf(File);
    expect(init.headers).toMatchObject({ 'x-csrf-token': 'csrf-token' });
    // Setting content-type by hand omits the multipart boundary, and the API
    // then parses no file at all -- a 400 that looks like a server bug.
    expect(Object.keys(init.headers as Record<string, string>).map((key) => key.toLowerCase())).not.toContain('content-type');
  });

  it('replaces at the asset own route -- a new asset, not an overwrite of the old bytes', async () => {
    vi.stubGlobal('document', { cookie: 'eow_csrf=csrf-token' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(assetBody({ id: 'asset-2' })), { status: 201 }));

    await expect(replaceAsset('asset-1', pngFile('new.png'))).resolves.toMatchObject({ id: 'asset-2' });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/assets/asset-1/replace'), expect.objectContaining({ method: 'POST' }));
    expect(initOf(fetchMock).body).toBeInstanceOf(FormData);
  });

  it('archives with DELETE and reads no body from the 204', async () => {
    vi.stubGlobal('document', { cookie: 'eow_csrf=csrf-token' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

    await expect(archiveAsset('asset-1')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/assets/asset-1'), expect.objectContaining({ method: 'DELETE', headers: expect.objectContaining({ 'x-csrf-token': 'csrf-token' }) }));
  });

  it('surfaces the API refusal code so the panel can say why an image was rejected', async () => {
    vi.stubGlobal('document', { cookie: 'eow_csrf=csrf-token' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: 'SVG_REJECTED', title: 'Unsupported', detail: 'SVG images are not accepted.' }), { status: 415 }));

    // ApiError keeps the whole Problem, so the panel can tell SVG_REJECTED
    // apart from UNSUPPORTED_TYPE and say the right thing about each.
    await expect(uploadAsset(pngFile('logo.svg'))).rejects.toMatchObject({ status: 415, problem: { code: 'SVG_REJECTED' } });
  });
});

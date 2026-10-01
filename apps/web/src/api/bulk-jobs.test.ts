import { afterEach, describe, expect, it, vi } from 'vitest';
import { bulkJobErrorFileUrl, bulkJobResultFileUrl, createBulkJob, getBulkJob, listBulkJobs, previewBulkJob } from './bulk-jobs.js';

describe('createBulkJob', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts a custom-data selection with CSRF and idempotency headers', async () => {
    vi.stubGlobal('document', { cookie: 'eow_csrf=csrf-token' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ jobId: 'job-1' }), { status: 202 }));
    await expect(createBulkJob({ action: 'set_custom_data', actionPayload: { key: 'department_code', value: 'MKT' }, recipientIds: ['recipient-1'] })).resolves.toMatchObject({ jobId: 'job-1' });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/bulk-jobs'), expect.objectContaining({ method: 'POST', credentials: 'include', headers: expect.objectContaining({ 'x-csrf-token': 'csrf-token', 'idempotency-key': expect.any(String) }) }));
  });

  it('reads canonical bulk results and exposes the tenant-scoped failure artifact URL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify([{ jobId: 'job-1' }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: 'job-1', status: 'partial_success' }), { status: 200 }));

    await expect(listBulkJobs()).resolves.toEqual([{ jobId: 'job-1' }]);
    await expect(getBulkJob('job-1')).resolves.toMatchObject({ status: 'partial_success' });
    expect(bulkJobErrorFileUrl('job-1')).toContain('/bulk-jobs/job-1/error-file');
    expect(bulkJobResultFileUrl('job-1')).toContain('/bulk-jobs/job-1/result-file');
    expect(fetchMock).toHaveBeenNthCalledWith(1, expect.stringContaining('/bulk-jobs'), { credentials: 'include' });
    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.stringContaining('/bulk-jobs/job-1'), { credentials: 'include' });
  });

  it('posts the proposed action to the authoritative dry-run endpoint before confirmation', async () => {
    vi.stubGlobal('document', { cookie: 'eow_csrf=csrf-token' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ scope: 'selected_recipients', estimatedCount: 2 }), { status: 200 }));

    await expect(previewBulkJob({ action: 'set_custom_data', actionPayload: { key: 'tier', value: 'gold' }, recipientIds: ['recipient-1', 'recipient-2'] }))
      .resolves.toMatchObject({ scope: 'selected_recipients', estimatedCount: 2 });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/bulk-jobs/preview'), expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'x-csrf-token': 'csrf-token' }) }));
  });
});

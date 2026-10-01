export type ReadinessCheckDto = { ok: boolean; latencyMs: number };
export type ReadinessResponseDto = {
  status: 'ready' | 'unready';
  checks: { database: ReadinessCheckDto; redis: ReadinessCheckDto };
};

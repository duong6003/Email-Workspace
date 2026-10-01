import { describe, expect, it } from 'vitest';
import { isLegalCampaignExecutionTransition, isLegalMessageTransition, type MessageStatus } from './send-state-machine.js';
import type { CampaignStatus } from '../database/entities/campaign.entity.js';

/**
 * M5-S3 CP2, RED first (BR-SEND-001/002). Exhaustive over the full grid
 * rather than a handful of examples, because "a transition outside the
 * machine returns 409" is a claim about every illegal pair, not just the
 * ones someone thought to write down.
 */
const ALL_CAMPAIGN_STATUSES: CampaignStatus[] = [
  'draft', 'scheduled', 'blocked', 'missed', 'queued', 'validating', 'sending',
  'paused', 'completed', 'partial_failed', 'failed', 'cancelled',
];

// SS3.3's table plus M6-S3/ADR-027's two pause/resume edges: this module
// owns exactly these ten edges among the send-execution states. Every other
// campaign-status transition -- including draft->scheduled and
// scheduled->queued, which are real and legal but belong to M4-S1/M5-S2's
// own already-closed code paths -- is out of scope for BR-SEND-001/
// BR-SEND-009 and must read as illegal here.
const LEGAL_CAMPAIGN_EDGES: Array<[CampaignStatus, CampaignStatus]> = [
  ['queued', 'validating'],
  ['validating', 'sending'],
  ['validating', 'failed'],
  ['validating', 'completed'],
  ['sending', 'completed'],
  ['sending', 'partial_failed'],
  ['sending', 'failed'],
  ['sending', 'cancelled'],
  ['sending', 'paused'],
  ['paused', 'sending'],
];

describe('isLegalCampaignExecutionTransition (BR-SEND-001)', () => {
  it('admits exactly the eight SS3.3 edges and refuses every other pair in the full 12x12 grid', () => {
    const legal = new Set(LEGAL_CAMPAIGN_EDGES.map(([from, to]) => `${from}->${to}`));
    const mismatches: string[] = [];
    for (const from of ALL_CAMPAIGN_STATUSES) {
      for (const to of ALL_CAMPAIGN_STATUSES) {
        const expected = legal.has(`${from}->${to}`);
        const actual = isLegalCampaignExecutionTransition(from, to);
        if (actual !== expected) mismatches.push(`${from}->${to}: expected ${expected}, got ${actual}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('refuses every self-transition, including for states with legal outgoing edges', () => {
    for (const status of ALL_CAMPAIGN_STATUSES) {
      expect(isLegalCampaignExecutionTransition(status, status)).toBe(false);
    }
  });

  it('ADR-027 (BR-SEND-009): admits exactly sending<->paused and refuses every other pause-touching pair', () => {
    expect(isLegalCampaignExecutionTransition('sending', 'paused')).toBe(true);
    expect(isLegalCampaignExecutionTransition('paused', 'sending')).toBe(true);
    for (const status of ALL_CAMPAIGN_STATUSES) {
      if (status === 'sending') continue;
      expect(isLegalCampaignExecutionTransition(status, 'paused')).toBe(false);
    }
    for (const status of ALL_CAMPAIGN_STATUSES) {
      if (status === 'sending') continue;
      expect(isLegalCampaignExecutionTransition('paused', status)).toBe(false);
    }
  });

  it('refuses transitions owned by other slices (draft->scheduled, scheduled->queued)', () => {
    expect(isLegalCampaignExecutionTransition('draft', 'scheduled')).toBe(false);
    expect(isLegalCampaignExecutionTransition('scheduled', 'queued')).toBe(false);
  });
});

const ALL_MESSAGE_STATUSES: MessageStatus[] = [
  'pending', 'queued', 'submitted', 'delivered', 'bounced', 'failed', 'skipped', 'cancelled',
];

// SS3.3's diagram: claim, submit, and the two DEC-096 webhook edges
// (legal but unreached until M5-S4). 'skipped' is set only at freeze
// (INSERT), never entered via an UPDATE transition (D-88) -- so it has zero
// legal inbound edges here despite being a real, reachable status.
const LEGAL_MESSAGE_EDGES: Array<[MessageStatus, MessageStatus]> = [
  ['pending', 'queued'],
  ['pending', 'cancelled'],
  ['queued', 'submitted'],
  ['queued', 'failed'],
  ['submitted', 'delivered'],
  ['submitted', 'bounced'],
];

describe('isLegalMessageTransition (BR-SEND-002)', () => {
  it('admits exactly the six SS3.3 diagram edges and refuses every other pair in the full 8x8 grid', () => {
    const legal = new Set(LEGAL_MESSAGE_EDGES.map(([from, to]) => `${from}->${to}`));
    const mismatches: string[] = [];
    for (const from of ALL_MESSAGE_STATUSES) {
      for (const to of ALL_MESSAGE_STATUSES) {
        const expected = legal.has(`${from}->${to}`);
        const actual = isLegalMessageTransition(from, to);
        if (actual !== expected) mismatches.push(`${from}->${to}: expected ${expected}, got ${actual}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("'skipped' has no legal inbound transition from any status", () => {
    for (const from of ALL_MESSAGE_STATUSES) {
      expect(isLegalMessageTransition(from, 'skipped')).toBe(false);
    }
  });

  it('terminal statuses (delivered, bounced, failed, cancelled, skipped) have no legal outgoing transition', () => {
    for (const from of ['delivered', 'bounced', 'failed', 'cancelled', 'skipped'] as MessageStatus[]) {
      for (const to of ALL_MESSAGE_STATUSES) {
        expect(isLegalMessageTransition(from, to)).toBe(false);
      }
    }
  });
});

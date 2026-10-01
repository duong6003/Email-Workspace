import type { CampaignDraft, CampaignPatch } from '../../api/campaigns.js';
import { autosaveReducer, type AutosaveAction as GenericAction, type AutosaveState as GenericState, type AutosaveStatus } from '../../api/autosave-reducer.js';

export type { AutosaveStatus };
export type AutosaveState = GenericState<CampaignDraft, CampaignPatch>;
export type AutosaveAction = GenericAction<CampaignDraft, CampaignPatch>;
export { autosaveReducer };

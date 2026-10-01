import type { operations, components } from './openapi.js';

/**
 * Compile-time proof that generated types match the auth surface this
 * package exists to expose. A spec edit that drops or reshapes one of these
 * breaks `tsc --noEmit` here before it breaks a consumer in apps/web.
 */
type LoginRequestBody = operations['login']['requestBody']['content']['application/json'];
type _LoginRequestShape = LoginRequestBody extends components['schemas']['LoginRequest'] ? true : never;
const _login: _LoginRequestShape = true;

type MeResponseBody = operations['getCurrentUser']['responses'][200]['content']['application/json'];
type _MeResponseShape = MeResponseBody extends components['schemas']['Me'] ? true : never;
const _me: _MeResponseShape = true;

type LogoutResponses = operations['logout']['responses'];
type _LogoutHas204 = 204 extends keyof LogoutResponses ? true : never;
const _logout: _LogoutHas204 = true;

type CampaignCreateRequest = operations['createCampaignDraft']['requestBody']['content']['application/json'];
type _CampaignCreateRequestShape = CampaignCreateRequest extends components['schemas']['CampaignDraftCreateRequest'] ? true : never;
const _campaignCreate: _CampaignCreateRequestShape = true;

type CampaignUpdateRequest = operations['updateCampaignDraft']['requestBody']['content']['application/json'];
type _CampaignUpdateRequestShape = CampaignUpdateRequest extends components['schemas']['CampaignDraftUpdateRequest'] ? true : never;
const _campaignUpdate: _CampaignUpdateRequestShape = true;

type CampaignResponse = operations['getCampaign']['responses'][200]['content']['application/json'];
type _CampaignResponseShape = CampaignResponse extends components['schemas']['Campaign'] ? true : never;
const _campaignResponse: _CampaignResponseShape = true;

type AudiencePreviewRequest = operations['previewCampaignAudience']['requestBody']['content']['application/json'];
type _AudiencePreviewRequestShape = AudiencePreviewRequest extends components['schemas']['PreviewCampaignAudienceRequest'] ? true : never;
const _audiencePreviewRequest: _AudiencePreviewRequestShape = true;

type AudiencePreviewResponse = operations['previewCampaignAudience']['responses'][200]['content']['application/json'];
type _AudiencePreviewResponseShape = AudiencePreviewResponse extends components['schemas']['AudienceResolution'] ? true : never;
const _audiencePreviewResponse: _AudiencePreviewResponseShape = true;

type ValidateAudienceResponse = operations['validateCampaignAudience']['responses'][200]['content']['application/json'];
type _ValidateAudienceResponseShape = ValidateAudienceResponse extends components['schemas']['ValidateCampaignAudienceResponse'] ? true : never;
const _validateAudienceResponse: _ValidateAudienceResponseShape = true;

type AcceptAudienceWaiverResponse = operations['acceptCampaignAudienceWaiver']['responses'][201]['content']['application/json'];
type _AcceptAudienceWaiverResponseShape = AcceptAudienceWaiverResponse extends components['schemas']['Campaign'] ? true : never;
const _acceptAudienceWaiverResponse: _AcceptAudienceWaiverResponseShape = true;

type SendCampaignResponse = operations['sendCampaign']['responses'][202]['content']['application/json'];
type _SendCampaignResponseShape = SendCampaignResponse extends components['schemas']['CampaignSnapshotAccepted'] ? true : never;
const _sendCampaignResponse: _SendCampaignResponseShape = true;

type CancelCampaignResponse = operations['cancelCampaign']['responses'][202]['content']['application/json'];
type _CancelCampaignResponseShape = CancelCampaignResponse extends components['schemas']['CampaignSnapshotAccepted'] ? true : never;
const _cancelCampaignResponse: _CancelCampaignResponseShape = true;

type GetCampaignSnapshotResponse = operations['getCampaignSnapshot']['responses'][200]['content']['application/json'];
type _GetCampaignSnapshotResponseShape = GetCampaignSnapshotResponse extends components['schemas']['CampaignSnapshot'] ? true : never;
const _getCampaignSnapshotResponse: _GetCampaignSnapshotResponseShape = true;

void _login;
void _me;
void _logout;
void _campaignCreate;
void _campaignUpdate;
void _campaignResponse;
void _audiencePreviewRequest;
void _audiencePreviewResponse;
void _validateAudienceResponse;
void _acceptAudienceWaiverResponse;
void _sendCampaignResponse;
void _cancelCampaignResponse;
void _getCampaignSnapshotResponse;

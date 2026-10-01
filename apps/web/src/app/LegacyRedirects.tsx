import { Navigate, useParams, useSearchParams } from 'react-router-dom';

/**
 * The Chiến dịch restructure moved the composer from `/email/compose?draft=<id>`
 * to `/campaigns/:id/edit`. Saved links, bookmarks and the e2e suite still use
 * the old shape, so the query parameter is translated into the new path rather
 * than dropped -- a static <Navigate> cannot do this, because the target path
 * is built from the parameter.
 */
export function LegacyComposeRedirect() {
  const [searchParams] = useSearchParams();
  const draftId = searchParams.get('draft');
  return <Navigate to={draftId ? `/campaigns/${draftId}/edit` : '/campaigns/new'} replace />;
}

/** `/history/:campaignId` -> `/campaigns/:campaignId`, same reason. */
export function LegacyHistoryRedirect() {
  const { campaignId } = useParams<{ campaignId: string }>();
  return <Navigate to={campaignId ? `/campaigns/${campaignId}` : '/campaigns'} replace />;
}

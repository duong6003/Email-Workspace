import { Navigate, Route, Routes } from 'react-router-dom';
import LoginScreen from '../screens/auth/LoginScreen.js';
import { UnsubscribeScreen } from '../screens/unsubscribe/UnsubscribeScreen.js';
import { CampaignDetailScreen } from '../screens/campaigns/CampaignDetailScreen.js';
import { CampaignListScreen } from '../screens/campaigns/CampaignListScreen.js';
import { RecipientsScreen } from '../screens/recipients/RecipientsScreen.js';
import { CustomFieldsScreen } from '../screens/settings/CustomFieldsScreen.js';
import { GlobalVariablesScreen } from '../screens/settings/GlobalVariablesScreen.js';
import { TemplateEditorScreen } from '../screens/templates/TemplateEditorScreen.js';
import { TemplatesScreen } from '../screens/templates/TemplatesScreen.js';
import { BuilderScreen } from '../screens/templates/builder/BuilderScreen.js';
import { ComposeDraftScreen } from '../screens/compose/ComposeDraftScreen.js';
import { RequireAuth } from '../auth/RequireAuth.js';
import { RequirePermission } from '../auth/RequirePermission.js';
import { routePermissions } from './nav.js';
import { LegacyComposeRedirect, LegacyHistoryRedirect } from './LegacyRedirects.js';
import { AppShell } from './AppShell.js';
import SenderSettingsScreen from '../screens/settings/SenderSettingsScreen.js';

/**
 * Route table per ui-inventory.yaml → routing.routes (DEC-003: real
 * addressable routes, not the handoff's in-memory `view` state).
 *
 * Since the Chiến dịch restructure the whole campaign lifecycle lives under
 * /campaigns: the list, the composer (new and existing drafts) and the
 * detail screen with its send history. The former /email/* and /history/*
 * URLs are kept as redirects rather than deleted -- see LegacyRedirects.tsx.
 *
 * M1-S2: every route under the authenticated shell is wrapped in
 * RequirePermission (BR-AUTH-003/004) using the same requiredPermission
 * map AppShell's nav filtering reads from (nav.ts -> routePermissions), so
 * a role that cannot see a nav item also cannot reach it by typing the URL
 * directly -- e.g. a Viewer navigating to /settings/senders sees the
 * permission_denied state (EXECPLAN §7.4 M1-S2 acceptance example).
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginScreen />} />

      {/* ADR-049. Outside RequireAuth and outside AppShell on purpose: the
          person following this link is a RECIPIENT, not a user -- they have no
          account, and the shell is a workspace they cannot enter. Until this
          route existed, every `{{unsubscribe_url}}` ever rendered fell through
          to the catch-all below and showed a not-found page. */}
      <Route path="/unsubscribe/:token" element={<UnsubscribeScreen />} />

      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route
          path="/campaigns"
          element={
            <RequirePermission permission={routePermissions['/campaigns']!}>
              <CampaignListScreen />
            </RequirePermission>
          }
        />
        <Route
          path="/campaigns/new"
          element={
            <RequirePermission permission={routePermissions['/campaigns/new']!}>
              <ComposeDraftScreen />
            </RequirePermission>
          }
        />
        <Route
          path="/campaigns/:campaignId/edit"
          element={
            <RequirePermission permission={routePermissions['/campaigns/:id/edit']!}>
              <ComposeDraftScreen />
            </RequirePermission>
          }
        />
        <Route
          path="/campaigns/:campaignId"
          element={
            <RequirePermission permission={routePermissions['/campaigns/:id']!}>
              <CampaignDetailScreen />
            </RequirePermission>
          }
        />

        {/* Legacy URLs from before the Chiến dịch restructure. Kept so saved
            links, bookmarks and the e2e suite keep working; both id-bearing
            forms translate their parameter rather than dropping it. */}
        <Route path="/email/compose" element={<LegacyComposeRedirect />} />
        <Route path="/email/drafts" element={<Navigate to="/campaigns" replace />} />
        <Route path="/history" element={<Navigate to="/campaigns" replace />} />
        <Route path="/history/:campaignId" element={<LegacyHistoryRedirect />} />

        <Route
          path="/recipients"
          element={
            <RequirePermission permission={routePermissions['/recipients']!}>
              <RecipientsScreen />
            </RequirePermission>
          }
        />
        <Route
          path="/templates"
          element={
            <RequirePermission permission={routePermissions['/templates']!}>
              <TemplatesScreen />
            </RequirePermission>
          }
        />
        {/* Reaching the editor needs exactly the permission the template
            section already requires; a second key would let the two drift.
            content:read is enough to *open* it -- TemplateEditorScreen renders
            itself read-only for a caller who cannot edit, which is the §5.1
            permission_denied state. content:manage is enforced inside the
            screen (and, authoritatively, by the API) rather than at the route,
            because gating the route on it would blank the screen instead. */}
        <Route
          path="/templates/:templateId/edit"
          element={
            <RequirePermission permission={routePermissions['/templates']!}>
              <TemplateEditorScreen />
            </RequirePermission>
          }
        />
        {/* ADR-041: builder-origin templates' editor, on its own path so
            AppShell can pick its chrome (focus mode) synchronously from the
            pathname, before any template is fetched. content:read is enough
            to open it read-only, matching /edit -- content:manage is
            enforced inside BuilderScreen (§2.1), not at the route. */}
        <Route
          path="/templates/:templateId/build"
          element={
            <RequirePermission permission={routePermissions['/templates/:id/build']!}>
              <BuilderScreen />
            </RequirePermission>
          }
        />
        <Route
          path="/settings/senders"
          element={
            <RequirePermission permission={routePermissions['/settings/senders']!}>
            <SenderSettingsScreen />
            </RequirePermission>
          }
        />
        <Route
          path="/settings/policy"
          element={<RequirePermission permission={routePermissions['/settings/policy']!}><SenderSettingsScreen policyOnly /></RequirePermission>}
        />
        <Route
          path="/settings/custom-fields"
          element={
            <RequirePermission permission={routePermissions['/settings/custom-fields']!}>
              <CustomFieldsScreen />
            </RequirePermission>
          }
        />
        <Route
          path="/settings/global-variables"
          element={
            <RequirePermission permission={routePermissions['/settings/global-variables']!}>
              <GlobalVariablesScreen />
            </RequirePermission>
          }
        />
      </Route>

      <Route path="/" element={<Navigate to="/campaigns" replace />} />
      <Route path="*" element={<Navigate to="/campaigns" replace />} />
    </Routes>
  );
}

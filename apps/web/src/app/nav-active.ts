/**
 * A consolidated nav entry (e.g. "Cấu hình") must light up on every one of
 * its sibling routes, not just its own `to` path. react-router's NavLink
 * only matches a path and its descendants, so the shell computes this
 * itself instead of relying on NavLink's isActive.
 *
 * Descendants count too, which is what keeps "Chiến dịch" lit on
 * /campaigns/:id and /campaigns/:id/edit. The trailing slash in the prefix
 * test is load-bearing: without it, /campaigns would also claim a sibling
 * route like /campaigns-archive.
 */
export function isNavItemActive(item: { path: string; activePaths?: string[] }, pathname: string): boolean {
  return pathname === item.path
    || pathname.startsWith(`${item.path}/`)
    || (item.activePaths?.includes(pathname) ?? false);
}

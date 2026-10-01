-- ADR-049: the recipient-facing opt-out route.
--
-- Until now `{{unsubscribe_url}}` rendered a real, unique, per-recipient URL
-- that resolved to nothing: no web route, no controller, no handler anywhere.
-- The template lint warned that a missing token "will be blocked at send",
-- which was also untrue -- nothing blocks a send for it. So the product asked
-- authors for an unsubscribe link, shipped one, and had no way to honour it.
--
-- The route is `@Public()`: the click comes from a recipient's mail client and
-- carries none of our cookies. That puts it in exactly the position
-- 077_asset_serve_bypass.sql documented at length -- `recipient_tenant_isolation`
-- (012_rls.sql) is `USING (tenant_id = current_tenant_id())`, and that function
-- returns NULL when `app.tenant_id` was never set, so a tenant-blind lookup as
-- eow_app matches zero rows every time. Deterministically, not flakily.
--
-- Same fix, same shape: eow_app stays RLS-restricted everywhere else and gets
-- narrow SECURITY DEFINER functions scoped to precisely what this one route
-- does, returning only the columns it uses.
--
-- The write function is the security-critical half, and it is written so that
-- bypassing RLS grants nothing beyond the intended act:
--
--   * the target status is a LITERAL in the function body. There is no
--     parameter for it, so this can only ever unsubscribe someone -- it can
--     never reactivate anyone, which BR-REC-004 reserves for an Admin
--     confirming re-consent, and never set 'bounced' or 'paused'.
--   * it touches two columns. Not email, not custom_data, not tenant_id.
--   * it takes a recipient id and nothing else, so there is no path, tenant or
--     predicate a caller can influence.
--   * a soft-deleted recipient (BR-GEN-006) is invisible to it, the same way
--     they are to every other read.
--
-- The capability to CALL it is the signed token in the link
-- (`unsubscribe-token.ts`); the API verifies that signature before it gets
-- here. This function is deliberately not a second place that decides who may
-- unsubscribe -- it decides only what unsubscribing does.

-- Read-only: what the confirmation page shows before anyone has agreed to
-- anything. Separate from the write so a GET can never change state -- mail
-- security scanners fetch links in transit, and a GET that unsubscribed would
-- unsubscribe people who never clicked.
CREATE FUNCTION find_unsubscribe_target(p_recipient_id uuid)
RETURNS TABLE (email text, already_unsubscribed boolean)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT recipient.email, recipient.subscription_status = 'unsubscribed'
  FROM recipient
  WHERE recipient.id = p_recipient_id
    AND recipient.deleted_at IS NULL
$$;

-- The write. Idempotent: a second click reports success rather than an error,
-- because the recipient's intent is already satisfied and an error page would
-- read as "your unsubscribe did not work".
CREATE FUNCTION redeem_unsubscribe(p_recipient_id uuid, p_trace_id text)
RETURNS TABLE (email text, already_unsubscribed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  target record;
BEGIN
  SELECT recipient.id, recipient.tenant_id, recipient.email, recipient.subscription_status
    INTO target
    FROM recipient
   WHERE recipient.id = p_recipient_id
     AND recipient.deleted_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF target.subscription_status = 'unsubscribed' THEN
    email := target.email;
    already_unsubscribed := true;
    RETURN NEXT;
    RETURN;
  END IF;

  UPDATE recipient
     SET subscription_status = 'unsubscribed',
         unsubscribed_at = now()
   WHERE recipient.id = p_recipient_id;

  -- BR-SEC-002: every consequential action leaves a row. actor_id is NULL
  -- because a recipient is not a user of this system -- the same shape the
  -- permission guard uses when it has nobody to attribute a denial to.
  INSERT INTO audit_log (tenant_id, actor_id, action, entity_type, entity_id, trace_id, metadata)
  VALUES (target.tenant_id, NULL, 'recipient.unsubscribed', 'recipient', p_recipient_id, p_trace_id,
          jsonb_build_object('source', 'unsubscribe_link'));

  email := target.email;
  already_unsubscribed := false;
  RETURN NEXT;
END
$$;

GRANT EXECUTE ON FUNCTION find_unsubscribe_target(uuid) TO eow_app;
GRANT EXECUTE ON FUNCTION redeem_unsubscribe(uuid, text) TO eow_app;

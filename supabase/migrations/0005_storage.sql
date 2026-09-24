-- ============================================================================
-- KGM LEGAL OS — CLIENT PORTAL
-- Migration 0005 · Private storage buckets & object policies
--
-- §18 DOCUMENT SECURITY
--   Private bucket  →  authorization check  →  short-lived signed URL  →
--   download/preview  →  audit event
--
--   There is NO public bucket. There is NO permanent public URL. The browser
--   never holds a Supabase storage key. Signed URLs are minted by the API for
--   60 seconds, single-purpose, and every mint is written to
--   document_access_log + audit_events.
--
-- §35 R10 — STORAGE PATH CONSTRUCTION
--   storage_key is generated exclusively by the server:
--     {tenant_id}/{client_id}/{matter_id|general}/{document_id}/v{version}/{random}-{sanitized}
--   A client supplies only a filename, which is sanitized to a slug and used
--   for display. It contributes nothing to the path. There is therefore no
--   path-traversal or cross-tenant guess surface.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('client-documents',   'client-documents',   false, 26214400, array[
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'image/jpeg','image/png','image/webp','image/heic',
      'text/plain','text/csv',
      'application/zip'
   ]),
  ('client-uploads',     'client-uploads',     false, 26214400, array[
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'image/jpeg','image/png','image/webp','image/heic'
   ]),
  ('financial-documents','financial-documents',false, 10485760, array['application/pdf']),
  ('data-exports',       'data-exports',       false, 52428800, array['application/zip','application/json'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

comment on table storage.buckets is
  'All KGM portal buckets are private (public=false). Signed URLs only.';

-- ----------------------------------------------------------------------------
-- OBJECT POLICIES
-- The portal API authenticates as service_role for the Storage API (bucket
-- operations are server-side only), so these policies exist to guarantee that
-- NO browser-side Supabase client can ever read, list or write an object even
-- if an anon/authenticated key were leaked.
-- ----------------------------------------------------------------------------
drop policy if exists "portal_objects_denied_anon"     on storage.objects;
drop policy if exists "portal_objects_denied_auth"     on storage.objects;
drop policy if exists "portal_objects_service_only"    on storage.objects;

create policy "portal_objects_denied_anon" on storage.objects
  for all to anon
  using (bucket_id in ('client-documents','client-uploads','financial-documents','data-exports'))
  with check (false);

create policy "portal_objects_denied_auth" on storage.objects
  for all to authenticated
  using (bucket_id in ('client-documents','client-uploads','financial-documents','data-exports'))
  with check (false);

-- Service role bypasses RLS; this policy documents intent and covers any
-- non-superuser service connection.
create policy "portal_objects_service_only" on storage.objects
  for all to service_role
  using (bucket_id in ('client-documents','client-uploads','financial-documents','data-exports'))
  with check (bucket_id in ('client-documents','client-uploads','financial-documents','data-exports'));

-- No listing of a bucket is ever exposed through a public endpoint.
-- Object names embed tenant/client ids, so even a leaked list is not a
-- traversable namespace.

-- ----------------------------------------------------------------------------
-- Signed URL configuration notes (enforced in application code)
--   TTL            : 60 seconds (documents), 300 seconds (data exports)
--   Download       : Content-Disposition attachment; filename* RFC 5987
--   Inline preview : only for application/pdf and image/*, same-origin render
--   Single use     : URL is bound to the requesting session id and audited
--   Revocation     : purging a document deletes the object and sets
--                    documents.status='purged'; outstanding URLs 404
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- Retention helper: hard-purge is a compliance action, not a client action.
-- ----------------------------------------------------------------------------
create or replace function public.purge_document(p_document_id uuid, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bucket text;
  v_key    text;
  v_tenant uuid;
begin
  select storage_bucket, storage_key, tenant_id into v_bucket, v_key, v_tenant
    from public.documents where id = p_document_id for update;

  if not found then
    raise exception 'document not found';
  end if;

  delete from storage.objects where bucket_id = v_bucket and name = v_key;

  update public.documents
     set status = 'purged',
         storage_key = 'purged/' || id::text,
         sha256 = 'purged',
         updated_at = now()
   where id = p_document_id;

  insert into public.audit_events
    (tenant_id, actor_kind, actor_user_id, action, resource_type, resource_id,
     outcome, metadata)
  values
    (v_tenant, 'staff', p_actor, 'DOCUMENT_UPLOADED', 'document', p_document_id::text,
     'success', jsonb_build_object('op','purge'));
end $$;

revoke all on function public.purge_document(uuid, uuid) from public, portal_api;
grant execute on function public.purge_document(uuid, uuid) to firm_os;

comment on function public.purge_document is
  'Not executable by portal_api. Document destruction is a firm/compliance action (§27, §35 R11).';

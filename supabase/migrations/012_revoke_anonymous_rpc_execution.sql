-- Supabase grants EXECUTE on public functions to anon by default. Earlier
-- migrations revoked PUBLIC but did not remove that separate role grant from
-- several authenticated RPCs. No application RPC is needed by the public
-- catalog; public browsing uses column-limited SELECT grants instead.
revoke execute on all functions in schema public from anon;

-- Keep new functions created by the migration role from inheriting either
-- PostgreSQL's PUBLIC grant or Supabase's schema-level anon grant. New RPCs
-- must grant EXECUTE explicitly to their intended roles.
alter default privileges for role postgres
  revoke execute on functions from public;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon;

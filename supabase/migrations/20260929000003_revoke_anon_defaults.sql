-- Supabase otorga por defecto permisos a anon sobre tablas nuevas. RLS ya las protege,
-- pero anon no debe tener acceso a nada: se revoca en lo existente y en lo futuro.
revoke all on public.document_attachments, public.portal_access, public.tenant_member_list, public.document_balances from anon;
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon;

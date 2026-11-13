-- SCRAN: account deletion and limits on what can be saved, before other people sign in.
-- Paste all of this into Supabase → SQL Editor → New query, and Run. Safe to run again.

-- ─────────────────────────────────────────────
-- 1. "Delete my account" in the profile panel. Removing the login removes the profile, and
--    with it every rating, saved place and follow (they all cascade from profiles).
--    Only signed-in people can call it, and only for themselves.
-- ─────────────────────────────────────────────
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  delete from auth.users where id = auth.uid();
end $$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- ─────────────────────────────────────────────
-- 2. Limits, so nobody can save junk through the API (the app never goes past these)
-- ─────────────────────────────────────────────
alter table ratings drop constraint if exists ratings_rating_range;
alter table ratings add constraint ratings_rating_range check (rating between 1 and 10);

alter table ratings drop constraint if exists ratings_text_length;
alter table ratings add constraint ratings_text_length
  check (char_length(coalesce(note, '')) <= 1000 and char_length(coalesce(restaurant_name, '')) <= 200);

alter table bookmarks drop constraint if exists bookmarks_text_length;
alter table bookmarks add constraint bookmarks_text_length check (char_length(coalesce(name, '')) <= 200);

alter table follows drop constraint if exists follows_creator_key_length;
alter table follows add constraint follows_creator_key_length check (char_length(coalesce(creator_key, '')) <= 40);

-- ─────────────────────────────────────────────
-- 3. Check: every SCRAN table has row-level security on, and its rules. Look over the
--    results: profiles, ratings and follows are readable by everyone; bookmarks only by you;
--    every change is limited to your own rows.
-- ─────────────────────────────────────────────
select c.relname as table_name, c.relrowsecurity as rls_on, p.policyname, p.cmd, p.qual, p.with_check
from pg_class c
join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
left join pg_policies p on p.schemaname = 'public' and p.tablename = c.relname
where c.relkind = 'r'
order by c.relname, p.cmd;

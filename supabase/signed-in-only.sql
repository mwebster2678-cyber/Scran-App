-- SCRAN: people's data only for signed-in users, and email/password accounts alongside Google.
-- Paste all of this into Supabase → SQL Editor → New query, and Run. Safe to run again.

-- ─────────────────────────────────────────────
-- 1. Profiles, ratings and follows can only be read by someone signed in, so the signed-out
--    limits in the app hold at the database too (bookmarks were already private).
-- ─────────────────────────────────────────────
drop policy if exists "Profiles are public" on profiles;
drop policy if exists "Profiles for signed-in users" on profiles;
create policy "Profiles for signed-in users" on profiles for select to authenticated using (true);

drop policy if exists "Ratings are public" on ratings;
drop policy if exists "Ratings for signed-in users" on ratings;
create policy "Ratings for signed-in users" on ratings for select to authenticated using (true);

drop policy if exists "Follows are public" on follows;
drop policy if exists "Follows for signed-in users" on follows;
create policy "Follows for signed-in users" on follows for select to authenticated using (true);

-- ─────────────────────────────────────────────
-- 2. Email sign-in is staying on, so stop EJ's test players signing in to SCRAN (their
--    passwords are in EJ's files). Their accounts are kept, just blocked; to unblock:
--    update auth.users set banned_until = null where email like '%@fakeplayer.ej' or email like '%@test.com';
-- ─────────────────────────────────────────────
update auth.users set banned_until = 'infinity'
where email like '%@fakeplayer.ej' or email like '%@test.com';

-- ─────────────────────────────────────────────
-- 3. Profiles for email accounts: made once the email is confirmed (so unconfirmed sign-ups
--    don't appear in people search), with the name typed at sign-up trimmed to 60 characters
-- ─────────────────────────────────────────────
create or replace function public.sync_profile() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  display_name text := left(nullif(trim(coalesce(new.raw_user_meta_data->>'full_name',
                                                 new.raw_user_meta_data->>'name', '')), ''), 60);
begin
  if new.email_confirmed_at is null then
    return new;
  end if;
  insert into profiles (id, name, avatar_url)
  values (
    new.id,
    coalesce(display_name, 'SCRAN user'),
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture')
  )
  on conflict (id) do update set name = excluded.name, avatar_url = excluded.avatar_url;
  return new;
end $$;

drop trigger if exists on_auth_user_saved on auth.users;
create trigger on_auth_user_saved
  after insert or update of raw_user_meta_data, email_confirmed_at on auth.users
  for each row execute function public.sync_profile();

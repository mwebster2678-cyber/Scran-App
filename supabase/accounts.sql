-- SCRAN accounts: profiles from Google, ratings and saved places on your account, following
-- people and creators. Paste the whole file into Supabase → SQL Editor → New query, and Run.
-- Safe to run again.

-- ─────────────────────────────────────────────
-- 1. Put the old EJ multi-sports app away in its own `ej` schema, untouched, so SCRAN can
--    use these table names. Nothing of EJ's is deleted (tables, data, policies, triggers,
--    test players). The app can't reach `ej` (Supabase only serves `public`), so it sits dormant.
--    To bring EJ back: give it its own Supabase project and move the tables there, or move them
--    back with `alter table ej.<name> set schema public` once SCRAN's are out of the way, and
--    re-create its sign-up trigger: create trigger on_auth_user_created after insert on
--    auth.users for each row execute function ej.handle_new_user();
-- ─────────────────────────────────────────────
create schema if not exists ej;

do $$
declare t text;
begin
  -- EJ's profiles has a username column and its follows has no creator_key; SCRAN's are the
  -- other way round, so a re-run leaves SCRAN's alone
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'profiles' and column_name = 'username') then
    alter table public.profiles set schema ej;
  end if;
  if to_regclass('public.follows') is not null and not exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'follows' and column_name = 'creator_key') then
    alter table public.follows set schema ej;
  end if;
  foreach t in array array['sports', 'leagues', 'league_members', 'league_join_requests',
                           'matches', 'challenges', 'messages'] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I set schema ej', t);
    end if;
  end loop;
  foreach t in array array['handle_new_user', 'update_stats_on_confirm', 'update_stats_on_insert',
                           'reverse_stats_on_dispute', 'reverse_stats_on_delete'] loop
    if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = t) then
      execute format('alter function public.%I() set schema ej', t);
    end if;
  end loop;
end $$;

-- EJ's sign-up hook would try to make an EJ profile for every new SCRAN user (and fail, as
-- Google gives no username). Its function is kept in ej; only the hook is removed.
drop trigger if exists on_auth_user_created on auth.users;

-- ─────────────────────────────────────────────
-- 2. Profiles: one per account, name and photo from Google, visible to everyone
-- ─────────────────────────────────────────────
create table if not exists profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  name       text not null,
  avatar_url text,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;
drop policy if exists "Profiles are public" on profiles;
create policy "Profiles are public" on profiles for select using (true);

-- Made at sign-up and refreshed at each sign-in, so a new Google name or photo carries over
create or replace function public.sync_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', 'SCRAN user'),
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture')
  )
  on conflict (id) do update set name = excluded.name, avatar_url = excluded.avatar_url;
  return new;
end $$;

drop trigger if exists on_auth_user_saved on auth.users;
create trigger on_auth_user_saved
  after insert or update of raw_user_meta_data on auth.users
  for each row execute function public.sync_profile();

-- Everyone who has already signed in with Google
insert into profiles (id, name, avatar_url)
select id,
  coalesce(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name', 'SCRAN user'),
  coalesce(raw_user_meta_data->>'avatar_url', raw_user_meta_data->>'picture')
from auth.users
where raw_app_meta_data->>'provider' = 'google'
   or id in (select user_id from ratings)
on conflict (id) do nothing;

-- ─────────────────────────────────────────────
-- 3. Ratings: everyone can see them; only you can change yours
-- ─────────────────────────────────────────────
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'ratings' loop
    execute format('drop policy %I on ratings', p.policyname);
  end loop;
end $$;

alter table ratings enable row level security;
create policy "Ratings are public"      on ratings for select using (true);
create policy "Add your own ratings"    on ratings for insert with check (auth.uid() = user_id);
create policy "Change your own ratings" on ratings for update using (auth.uid() = user_id);
create policy "Delete your own ratings" on ratings for delete using (auth.uid() = user_id);

-- Lets the app fetch a rating with the rater's name and photo in one go
delete from ratings where user_id not in (select id from profiles); -- accounts that no longer exist
alter table ratings drop constraint if exists ratings_user_profile_fkey;
alter table ratings add constraint ratings_user_profile_fkey
  foreign key (user_id) references profiles(id) on delete cascade;

-- ─────────────────────────────────────────────
-- 4. Saved places ("Want to visit"): private to you
-- ─────────────────────────────────────────────
create table if not exists bookmarks (
  user_id    uuid not null references profiles(id) on delete cascade,
  place_type text not null,
  place_id   text not null,
  name       text,
  lat        double precision,
  lon        double precision,
  cuisine    text[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (user_id, place_type, place_id)
);

alter table bookmarks enable row level security;
drop policy if exists "Your own saved places" on bookmarks;
create policy "Your own saved places" on bookmarks for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ─────────────────────────────────────────────
-- 5. Follows: a person following another person, or a creator (e.g. 'tod').
--    Anyone can follow anyone, and everyone can see who follows whom.
-- ─────────────────────────────────────────────
create table if not exists follows (
  follower_id uuid not null references profiles(id) on delete cascade,
  followee_id uuid references profiles(id) on delete cascade,
  creator_key text,
  created_at  timestamptz not null default now(),
  check ((followee_id is null) <> (creator_key is null)),
  check (followee_id is distinct from follower_id)
);

create unique index if not exists follows_person  on follows (follower_id, followee_id) where followee_id is not null;
create unique index if not exists follows_creator on follows (follower_id, creator_key) where creator_key is not null;
create index if not exists follows_followers on follows (followee_id);

alter table follows enable row level security;
drop policy if exists "Follows are public" on follows;
drop policy if exists "Follow as yourself" on follows;
drop policy if exists "Unfollow as yourself" on follows;
create policy "Follows are public" on follows for select using (true);
create policy "Follow as yourself" on follows for insert with check (auth.uid() = follower_id);
create policy "Unfollow as yourself" on follows for delete using (auth.uid() = follower_id);

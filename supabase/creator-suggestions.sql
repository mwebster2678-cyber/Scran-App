-- SCRAN: "Suggest a creator" in Explore. Signed-in people can send a suggestion; only admins
-- (you) can read or clear them, from the Suggestions tab of pipeline/review-verify.html.
-- Paste all of this into Supabase → SQL Editor → New query, and Run. Safe to run again.

-- ─────────────────────────────────────────────
-- 1. Admins. No one can read this table through the API; is_admin() checks it for the rules below.
-- ─────────────────────────────────────────────
create table if not exists admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table admins enable row level security;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins where user_id = auth.uid());
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- Make yourself the admin: put your sign-in email between the quotes, then run this line.
-- (Kept out of the repo on purpose: the repo is public.)
-- insert into admins (user_id) select id from auth.users where email = 'YOUR EMAIL HERE' on conflict do nothing;

-- ─────────────────────────────────────────────
-- 2. Suggestions
-- ─────────────────────────────────────────────
create table if not exists creator_suggestions (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references profiles(id) on delete cascade,
  suggestion  text not null,
  created_at  timestamptz not null default now(),
  constraint creator_suggestions_length check (char_length(suggestion) between 1 and 300)
);
alter table creator_suggestions enable row level security;

drop policy if exists "Suggest as yourself" on creator_suggestions;
drop policy if exists "Admins read suggestions" on creator_suggestions;
drop policy if exists "Admins clear suggestions" on creator_suggestions;
create policy "Suggest as yourself" on creator_suggestions for insert to authenticated
  with check (auth.uid() = user_id);
create policy "Admins read suggestions" on creator_suggestions for select to authenticated
  using (public.is_admin());
create policy "Admins clear suggestions" on creator_suggestions for delete to authenticated
  using (public.is_admin());

-- At most 10 suggestions per person per day, so no one can flood it
create or replace function public.limit_creator_suggestions() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from creator_suggestions
      where user_id = new.user_id and created_at > now() - interval '1 day') >= 10 then
    raise exception 'Too many suggestions today';
  end if;
  return new;
end $$;
drop trigger if exists creator_suggestions_limit on creator_suggestions;
create trigger creator_suggestions_limit before insert on creator_suggestions
  for each row execute function public.limit_creator_suggestions();

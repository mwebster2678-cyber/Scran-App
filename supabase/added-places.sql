-- SCRAN: places people add that aren't in data/places.json ("Can't find it? Add it" in search).
-- Everyone sees them as ordinary place dots. Run creator-suggestions.sql first (it makes is_admin()).
-- Paste all of this into Supabase → SQL Editor → New query, and Run. Safe to run again.

create table if not exists added_places (
  id         bigint generated always as identity primary key,
  name       text not null,
  kind       text not null,
  lat        double precision not null,
  lon        double precision not null,
  address    text,
  added_by   uuid default auth.uid() references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint added_places_name    check (char_length(name) between 1 and 200),
  constraint added_places_address check (char_length(coalesce(address, '')) <= 300),
  constraint added_places_kind    check (kind in ('eat', 'pub', 'cafe')),
  -- the box around the M25, like the app's map
  constraint added_places_london  check (lat between 51.22 and 51.74 and lon between -0.62 and 0.32)
);
alter table added_places enable row level security;

drop policy if exists "Added places are public" on added_places;
drop policy if exists "Add places as yourself" on added_places;
drop policy if exists "Remove your own added places" on added_places;
create policy "Added places are public" on added_places for select using (true);
create policy "Add places as yourself" on added_places for insert to authenticated
  with check (auth.uid() = added_by);
create policy "Remove your own added places" on added_places for delete to authenticated
  using (auth.uid() = added_by or public.is_admin());

-- At most 20 added places per person per day
create or replace function public.limit_added_places() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from added_places
      where added_by = new.added_by and created_at > now() - interval '1 day') >= 20 then
    raise exception 'Too many places added today';
  end if;
  return new;
end $$;
drop trigger if exists added_places_limit on added_places;
create trigger added_places_limit before insert on added_places
  for each row execute function public.limit_added_places();

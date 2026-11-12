-- Fix: ratings not saving to your account ("violates foreign key constraint ratings_user_id_fkey").
-- Paste all of this into Supabase → SQL Editor → New query, and Run. Safe to run again.

-- See where the old link points, before removing it
select confrelid::regclass as points_to
from pg_constraint where conname = 'ratings_user_id_fkey';

-- Remove the old link (ratings stay tied to accounts through ratings_user_profile_fkey)
alter table ratings drop constraint if exists ratings_user_id_fkey;

-- One rating per person per place, so the app can add or update it in one go
create unique index if not exists ratings_user_place on ratings (user_id, osm_type, osm_id);

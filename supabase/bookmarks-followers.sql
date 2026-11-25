-- Saved places ("Want to visit") become visible to the people who follow you, on your profile.
-- Your own stay readable and editable by you (accounts.sql). Policies add up, so this only widens reading.
-- Anyone can follow anyone (follows are public and need no approval), so this means "anyone who
-- has tapped Follow on you", as privacy.html says.
drop policy if exists "Followers see saved places" on bookmarks;
create policy "Followers see saved places" on bookmarks for select
  using (exists (
    select 1 from follows f
    where f.follower_id = auth.uid() and f.followee_id = bookmarks.user_id
  ));

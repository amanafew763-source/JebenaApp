-- Make an account an admin.
-- 1. Sign up on the website with your own email and confirm it.
-- 2. In Supabase: SQL Editor → New query → paste this, put your email in, Run.

update public.profiles
   set is_admin = true
 where id = (select id from auth.users where email = 'you@example.com');

-- To remove admin rights later, run the same query with "is_admin = false".

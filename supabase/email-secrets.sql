-- Tell the database where the "notify" function lives and the shared secret.
-- Run this once in the SQL Editor after deploying the function (README.md → "Email updates").
--
-- 1. Replace YOUR-PROJECT-REF with your project's reference (the part before
--    .supabase.co in your Project URL).
-- 2. Replace the secret with the SAME long random value you set as
--    NOTIFY_WEBHOOK_SECRET for the function.
-- Don't commit this file with real values filled in.

select vault.create_secret('https://YOUR-PROJECT-REF.supabase.co/functions/v1/notify', 'notify_url');
select vault.create_secret('PASTE-THE-SAME-LONG-RANDOM-SECRET-HERE', 'notify_secret');

-- To change a value later:
--   select vault.update_secret((select id from vault.secrets where name = 'notify_secret'), 'NEW-VALUE');

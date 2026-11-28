-- =====================================================================
-- EthioCarry — update of 28 Nov 2026: chat
--
-- Run this ONCE (SQL Editor → New query → paste → Run). Safe to run again.
-- Fresh projects don't need it: schema.sql already has it.
--
-- Adds a chat for each match (opens when the traveler accepts): messages
-- with text and photos, read receipts, the "My matches" list, live
-- updates, and an email for new messages once email is set up.
-- Phone numbers and emails of the two account holders are no longer shown
-- to each other; a separate hand-over or pickup person's phone still is.
-- =====================================================================

create or replace function public.same_phone(a text, b text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(ltrim(regexp_replace(a, '\D', '', 'g'), '0') = ltrim(regexp_replace(b, '\D', '', 'g'), '0'), false);
$$;

create or replace function public.request_details(p_id bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  r        public.requests;
  v_admin  boolean := public.is_admin();
  v_out    jsonb;
begin
  select * into r from public.requests where id = p_id;
  if r.id is null or (r.user_id <> auth.uid() and not v_admin) then
    raise exception 'not_your_request' using errcode = '42501';
  end if;

  v_out := jsonb_build_object(
    'request', to_jsonb(r) - 'user_id' - case when r.user_id = auth.uid() then 'nothing' else 'pickup_code' end,
    'events', coalesce((select jsonb_agg(jsonb_build_object('status', e.status, 'at', e.created_at) order by e.created_at)
                          from public.request_events e where e.request_id = r.id), '[]'::jsonb));

  if r.role = 'sender' then
    v_out := v_out || jsonb_build_object('match', (
      select jsonb_build_object(
               'id', m.id, 'status', m.status, 'flight_date', t.flight_date, 'trip_home_city', t.home_city,
               'traveler_first_name', split_part(btrim(t.contact_name), ' ', 1),
               'traveler_rating', public.user_rating(t.user_id),
               'rated', exists (select 1 from public.ratings x where x.match_id = m.id and x.rater_id = auth.uid()))
             -- Account holders talk in the chat: no phone numbers or emails are shared.
             || case when m.status in ('accepted', 'completed') then jsonb_build_object('traveler_name', t.contact_name)
                else '{}'::jsonb end
        from public.matches m join public.requests t on t.id = m.traveler_request_id
       where m.sender_request_id = r.id and m.status in ('proposed', 'accepted', 'completed')
       order by m.created_at desc limit 1));
  else
    v_out := v_out || jsonb_build_object(
      'used_kg', public.trip_used_kg(r.id),
      'items', coalesce((
        select jsonb_agg(
                 jsonb_build_object(
                   'match_id', m.id, 'match_status', m.status, 'item_status', s.status,
                   'handed_over', m.handed_over_at is not null, 'code_attempts', m.code_attempts,
                   'item_type', s.item_type, 'details', s.details, 'weight_kg', s.weight_kg,
                   'ready_date', s.ready_date, 'needed_by', s.needed_by, 'photo_path', s.photo_path,
                   'city', s.city, 'home_city', s.home_city, 'direction', s.direction,
                   'requester_first_name', split_part(btrim(s.contact_name), ' ', 1),
                   'requester_rating', public.user_rating(s.user_id),
                   'rated', exists (select 1 from public.ratings x where x.match_id = m.id and x.rater_id = auth.uid()))
                 -- After accepting: names, and the phone of a hand-over or pickup person only
                 -- when it's someone other than the sender (they can't use the chat).
                 || case when m.status in ('accepted', 'completed') then jsonb_build_object(
                      'requester_name', s.contact_name,
                      'handover_name', s.handover_name, 'pickup_name', s.pickup_name,
                      'handover_is_sender', public.same_phone(s.handover_phone, s.contact_phone),
                      'pickup_is_sender', public.same_phone(s.pickup_phone, s.contact_phone))
                    || case when not public.same_phone(s.handover_phone, s.contact_phone) then jsonb_build_object('handover_phone', s.handover_phone) else '{}'::jsonb end
                    || case when not public.same_phone(s.pickup_phone, s.contact_phone) then jsonb_build_object('pickup_phone', s.pickup_phone) else '{}'::jsonb end
                    else '{}'::jsonb end
                 order by m.created_at)
          from public.matches m join public.requests s on s.id = m.sender_request_id
         where m.traveler_request_id = r.id and m.status in ('proposed', 'accepted', 'completed')), '[]'::jsonb));
  end if;
  return v_out;
end;
$$;

-- ---------- chat between the two people of a match ----------
-- Opens once the traveler accepts. Only the two of them can write; both of
-- them and the admin can read. Messages are text (up to 1,000 characters)
-- and/or one photo (private bucket chat-images, folder = match id).

-- Who am I in this match? 'sender', 'traveler' or null.
create or replace function public.match_role(p_match bigint)
returns text language sql stable security definer set search_path = '' as $$
  select case when s.user_id = auth.uid() then 'sender' when t.user_id = auth.uid() then 'traveler' end
    from public.matches m
    join public.requests s on s.id = m.sender_request_id
    join public.requests t on t.id = m.traveler_request_id
   where m.id = p_match;
$$;

-- Writing is allowed while the match is accepted, and for 14 days after it
-- was completed (delivered) or cancelled after accepting.
create or replace function public.chat_open(p_match bigint)
returns boolean language sql stable security definer set search_path = '' as $$
  select m.status = 'accepted'
      or (m.status = 'completed' and m.completed_at > now() - interval '14 days')
      or (m.status = 'cancelled' and m.responded_at is not null and m.cancelled_at > now() - interval '14 days')
    from public.matches m where m.id = p_match;
$$;

-- Can I read this chat? Its two people (once accepted) and the admin.
create or replace function public.can_read_chat(p_match bigint)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_admin()
      or (public.match_role(p_match) is not null
          and exists (select 1 from public.matches m where m.id = p_match and m.responded_at is not null and m.status <> 'declined'));
$$;

create table if not exists public.messages (
  id          bigint generated always as identity primary key,
  match_id    bigint not null references public.matches (id) on delete cascade,
  sender_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  body        text not null default '' check (char_length(body) <= 1000),
  image_path  text,
  created_at  timestamptz not null default now(),
  check (btrim(body) <> '' or image_path is not null)
);
create index if not exists messages_match_idx on public.messages (match_id, created_at);

-- When each person last read a chat ("seen" ticks and unread counts).
create table if not exists public.match_reads (
  match_id      bigint not null references public.matches (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  last_read_at  timestamptz not null default now(),
  primary key (match_id, user_id)
);

-- New message: only the match's two people, while the chat is open, at most
-- 30 messages in 10 minutes, and a photo must be in this match's folder.
create or replace function public.prepare_message()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.sender_id := auth.uid();
  new.created_at := now();
  if public.match_role(new.match_id) is null then raise exception 'not_your_chat' using errcode = '42501'; end if;
  if not coalesce(public.chat_open(new.match_id), false) then raise exception 'chat_closed' using errcode = 'P0001'; end if;
  if (select count(*) from public.messages x where x.sender_id = new.sender_id and x.created_at > now() - interval '10 minutes') >= 30 then
    raise exception 'rate_limit' using errcode = 'P0001';
  end if;
  if new.image_path is not null and split_part(new.image_path, '/', 1) <> new.match_id::text then
    raise exception 'photo_not_yours' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists messages_prepare on public.messages;
create trigger messages_prepare before insert on public.messages
  for each row execute function public.prepare_message();

-- Mark a chat as read up to now.
create or replace function public.mark_chat_read(p_match bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.match_role(p_match) is null then return; end if;
  insert into public.match_reads (match_id, user_id, last_read_at) values (p_match, auth.uid(), now())
  on conflict (match_id, user_id) do update set last_read_at = now();
end;
$$;

-- Everything the "My matches" page and the chat header need, for the
-- logged-in person (or any match, for the admin with p_all).
create or replace function public.my_matches(p_all boolean default false)
returns table (match_id bigint, my_role text, status text, created_at timestamptz, responded_at timestamptz,
               other_first_name text, other_rating jsonb, sender_name text, traveler_name text,
               item_request_id bigint, trip_request_id bigint, direction public.request_dir, city text, home_city text,
               item_type public.item_type, weight_kg numeric, flight_date date, item_status public.request_status,
               handed_over boolean, chat_open boolean, can_chat boolean,
               unread integer, last_message_at timestamptz, other_last_read timestamptz)
language sql stable security definer set search_path = '' as $$
  select m.id,
         case when s.user_id = auth.uid() then 'sender' when t.user_id = auth.uid() then 'traveler' else 'admin' end,
         m.status, m.created_at, m.responded_at,
         split_part(btrim(case when s.user_id = auth.uid() then t.contact_name else s.contact_name end), ' ', 1),
         public.user_rating(case when s.user_id = auth.uid() then t.user_id else s.user_id end),
         case when public.is_admin() and p_all then s.contact_name end,
         case when public.is_admin() and p_all then t.contact_name end,
         s.id, t.id, s.direction, s.city, s.home_city, s.item_type, s.weight_kg, t.flight_date, s.status,
         m.handed_over_at is not null,
         coalesce(public.chat_open(m.id), false),
         m.responded_at is not null and m.status <> 'declined',
         (select count(*)::int from public.messages x
           where x.match_id = m.id and x.sender_id <> auth.uid()
             and x.created_at > coalesce((select r.last_read_at from public.match_reads r where r.match_id = m.id and r.user_id = auth.uid()), '-infinity'))
           * (case when s.user_id = auth.uid() or t.user_id = auth.uid() then 1 else 0 end),
         (select max(x.created_at) from public.messages x where x.match_id = m.id),
         (select r.last_read_at from public.match_reads r where r.match_id = m.id
             and r.user_id = case when s.user_id = auth.uid() then t.user_id else s.user_id end)
    from public.matches m
    join public.requests s on s.id = m.sender_request_id
    join public.requests t on t.id = m.traveler_request_id
   where (s.user_id = auth.uid() or t.user_id = auth.uid() or (p_all and public.is_admin()))
     and (m.status in ('proposed', 'accepted', 'completed') or m.responded_at is not null
          or (m.status in ('declined', 'cancelled') and m.created_at > now() - interval '30 days'))
   order by greatest(m.created_at, coalesce(m.responded_at, m.created_at),
                     coalesce((select max(x.created_at) from public.messages x where x.match_id = m.id), m.created_at)) desc
   limit case when p_all then 500 else 100 end;
$$;

alter table public.messages    enable row level security;
alter table public.match_reads enable row level security;
drop policy if exists "Messages: read" on public.messages;
create policy "Messages: read" on public.messages for select to authenticated
  using ((select public.can_read_chat(match_id)));
drop policy if exists "Messages: write own" on public.messages;
create policy "Messages: write own" on public.messages for insert to authenticated
  with check (sender_id = (select auth.uid()));
drop policy if exists "Reads: see the chat's" on public.match_reads;
create policy "Reads: see the chat's" on public.match_reads for select to authenticated
  using ((select public.can_read_chat(match_id)));

revoke all on public.messages, public.match_reads from anon, authenticated;
grant select on public.messages, public.match_reads to authenticated;
grant insert (match_id, body, image_path) on public.messages to authenticated;

do $$
declare f text;
begin
  foreach f in array array['public.prepare_message()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  -- match_role and chat_open are used by the photo rules, which run as the visitor.
  foreach f in array array['public.match_role(bigint)', 'public.chat_open(bigint)', 'public.can_read_chat(bigint)',
                           'public.mark_chat_read(bigint)', 'public.my_matches(boolean)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

-- Live updates: new messages and read receipts reach open chats instantly
-- (Supabase Realtime; the database rules above still decide who sees what).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'messages') then
      alter publication supabase_realtime add table public.messages;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'match_reads') then
      alter publication supabase_realtime add table public.match_reads;
    end if;
  end if;
end;
$$;

-- Photos in chats: private bucket, folder = match id.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-images', 'chat-images', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
drop policy if exists "Chat photos: upload" on storage.objects;
create policy "Chat photos: upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-images' and split_part(name, '/', 1) ~ '^[0-9]+$'
              and public.match_role(split_part(name, '/', 1)::bigint) is not null
              and coalesce(public.chat_open(split_part(name, '/', 1)::bigint), false));
drop policy if exists "Chat photos: view" on storage.objects;
create policy "Chat photos: view" on storage.objects for select to authenticated
  using (bucket_id = 'chat-images' and split_part(name, '/', 1) ~ '^[0-9]+$'
         and public.can_read_chat(split_part(name, '/', 1)::bigint));

-- Email about a new message (uses the same email function as the other
-- updates; does nothing until email is set up in Vault).
create or replace function public.notify_new_message()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_url text; v_secret text;
begin
  if to_regclass('vault.decrypted_secrets') is null then return new; end if;
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'notify_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'notify_secret';
  if v_url is null or v_secret is null or not exists (select 1 from pg_extension where extname = 'pg_net') then return new; end if;
  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', v_secret),
    body    := jsonb_build_object('event', 'message', 'message_id', new.id));
  return new;
end;
$$;
revoke all on function public.notify_new_message() from public, anon, authenticated;
drop trigger if exists messages_notify on public.messages;
create trigger messages_notify after insert on public.messages
  for each row execute function public.notify_new_message();

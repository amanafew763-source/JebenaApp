-- =====================================================================
-- Jebena Express — database schema for Supabase (PostgreSQL)
--
-- Run this once on a fresh project: SQL Editor → New query → paste this
-- whole file → Run.
--
-- What it creates
--   profiles         one row per account (name, admin flag)
--   requests         "I need something carried" items and "I'm traveling" trips
--   request_events   the timeline shown on each request's status page
--   matches          an item paired with a trip, through to pickup
--   ratings          stars both ways after a completed delivery
--   request_notes    the admin's private notes
--   visits           anonymous page-visit analytics
--   storage bucket   item-photos (private)
--
-- Security model (row-level security)
--   * Visitors who are not logged in can only record a page visit.
--   * Logged-in users create requests and read only their own. Travelers
--     need an account with a password; senders may sign in with a code.
--   * Contact details are shared between the two sides only after the
--     traveler accepts the item (see request_details).
--   * Only admins see everything, match requests and change statuses by
--     hand. Nobody can make themselves admin from the website.
-- =====================================================================

-- ---------- types ----------
create type public.request_role   as enum ('sender', 'traveler');   -- sender = "I need something carried"
create type public.request_dir    as enum ('to_addis', 'from_addis');  -- to / from Ethiopia (names kept from the Addis-only days)
create type public.request_status as enum ('new', 'waiting', 'matched', 'accepted', 'handed_over', 'delivered', 'cancelled');
create type public.item_type      as enum ('clothes', 'medicine', 'electronics', 'documents', 'food', 'other');

-- ---------- profiles ----------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text check (char_length(full_name) <= 120),
  is_admin    boolean not null default false,
  carry_types public.item_type[],        -- travelers: what they're usually willing to carry (pre-fills new trips)
  created_at  timestamptz not null default now()
);

create function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 120));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;

-- Senders can sign in with a one-time email code and never set a password; travelers must have one.
create function public.has_password()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select coalesce(u.encrypted_password, '') <> '' from auth.users u where u.id = auth.uid()), false);
$$;

-- ---------- home cities (the Ethiopia end of a route) ----------
-- Returns the country code ('ET') for a city we serve, null otherwise. Keep this list in
-- step with HOMES in assets/app.js.
create function public.home_country(p text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p in ('Addis Ababa', 'Adigrat', 'Arba Minch', 'Asosa', 'Bahir Dar', 'Bonga', 'Dire Dawa', 'Gambela', 'Harar',
               'Hawassa', 'Hosaena', 'Jijiga', 'Jimma', 'Mekelle', 'Semera', 'Shire', 'Wolaita Sodo') then 'ET'
  end;
$$;

grant execute on function public.home_country(text) to anon, authenticated;

-- ---------- requests ----------
create table public.requests (
  id                 bigint generated always as identity primary key,
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  role               public.request_role not null,
  direction          public.request_dir not null,
  city               text not null check (char_length(btrim(city)) between 2 and 80),   -- the city in the diaspora
  home_city          text not null default 'Addis Ababa' check (public.home_country(home_city) is not null),  -- the city in Ethiopia
  details            text not null check (char_length(btrim(details)) between 3 and 2000),
  contact_name       text not null check (char_length(btrim(contact_name)) between 1 and 120),
  contact_email      text not null check (contact_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(contact_email) <= 254),
  contact_phone      text not null check (contact_phone ~ '^\+?[0-9 ()./-]{6,25}$'),
  agreed_prohibited  boolean not null check (agreed_prohibited),
  lang               text not null default 'en' check (lang in ('en', 'de')),

  -- traveler trips
  flight_date        date,
  space_kg           numeric(5, 1) check (space_kg > 0 and space_kg <= 100),
  carry_types        public.item_type[] check (cardinality(carry_types) > 0),   -- what this traveler will carry on this trip

  -- items
  item_type          public.item_type,
  weight_kg          numeric(5, 1) check (weight_kg > 0 and weight_kg <= 100),
  ready_date         date,                -- the item can be handed to a traveler from this day
  needed_by          date,                -- optional: must arrive by this day
  photo_path         text check (char_length(photo_path) <= 300),
  handover_name      text check (char_length(btrim(handover_name)) between 1 and 120),
  handover_phone     text check (handover_phone ~ '^\+?[0-9 ()./-]{6,25}$'),
  pickup_name        text check (char_length(btrim(pickup_name)) between 1 and 120),
  pickup_phone       text check (pickup_phone ~ '^\+?[0-9 ()./-]{6,25}$'),
  pickup_code        text check (pickup_code ~ '^[0-9]{6}$'),

  status             public.request_status not null default 'new',
  fee_usd            numeric(10, 2) check (fee_usd >= 0),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint request_fields check (
    case role
      when 'traveler' then flight_date is not null and space_kg is not null
      else item_type is not null and weight_kg is not null and ready_date is not null
           and handover_name is not null and handover_phone is not null
           and pickup_name is not null and pickup_phone is not null
           and (needed_by is null or needed_by >= ready_date)
    end)
);

create index requests_user_id_idx    on public.requests (user_id);
create index requests_created_at_idx on public.requests (created_at desc);
create index requests_status_idx     on public.requests (status);

create function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger requests_touch_updated_at
  before update on public.requests
  for each row execute function public.touch_updated_at();

-- New requests: rate limit, no dates in the past, and a pickup code for items.
create function public.prepare_new_request()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.requests r
      where r.user_id = new.user_id and r.created_at > now() - interval '1 hour') >= 5 then
    raise exception 'rate_limit: too many requests, try again later' using errcode = 'P0001';
  end if;
  if new.role = 'traveler' and new.flight_date < current_date then
    raise exception 'date_in_past' using errcode = 'P0001';
  end if;
  if new.role = 'sender' and (new.ready_date < current_date or new.needed_by < current_date) then
    raise exception 'date_in_past' using errcode = 'P0001';
  end if;
  if new.photo_path is not null and new.photo_path not like new.user_id::text || '/%' then
    raise exception 'photo_not_yours' using errcode = 'P0001';
  end if;
  -- Trips say what they'll carry; items don't.
  if new.role = 'traveler' and new.carry_types is null then
    raise exception 'carry_types_required' using errcode = 'P0001';
  end if;
  if new.role = 'sender' then new.carry_types := null; end if;
  new.pickup_code := case when new.role = 'sender'
    then lpad((abs(hashtextextended(gen_random_uuid()::text, 0)) % 1000000)::text, 6, '0') end;
  return new;
end;
$$;

create trigger requests_prepare_new
  before insert on public.requests
  for each row execute function public.prepare_new_request();

-- ---------- timeline ----------
create table public.request_events (
  id          bigint generated always as identity primary key,
  request_id  bigint not null references public.requests (id) on delete cascade,
  status      public.request_status not null,
  created_at  timestamptz not null default now()
);
create index request_events_request_idx on public.request_events (request_id);

create function public.log_request_status()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.request_events (request_id, status) values (new.id, new.status);
  end if;
  return new;
end;
$$;

create trigger requests_log_status
  after insert or update of status on public.requests
  for each row execute function public.log_request_status();

-- ---------- matches ----------
-- proposed: the admin paired them; the traveler hasn't answered yet
-- accepted: the traveler said yes; both sides now see each other's contacts
-- completed: the pickup code was confirmed
create table public.matches (
  id                   bigint generated always as identity primary key,
  sender_request_id    bigint not null references public.requests (id) on delete cascade,
  traveler_request_id  bigint not null references public.requests (id) on delete cascade,
  status               text not null default 'proposed' check (status in ('proposed', 'accepted', 'declined', 'cancelled', 'completed')),
  created_by           uuid references auth.users (id) on delete set null,
  code_attempts        integer not null default 0,
  created_at           timestamptz not null default now(),
  responded_at         timestamptz,
  handed_over_at       timestamptz,
  completed_at         timestamptz,
  cancelled_at         timestamptz,
  check (sender_request_id <> traveler_request_id)
);
create unique index matches_one_open_per_item on public.matches (sender_request_id) where status in ('proposed', 'accepted');
create index matches_traveler_idx on public.matches (traveler_request_id);

-- Letters only, lower case: "Selam T." and "selam t" compare equal.
create function public.norm_name(p text)
returns text language sql immutable set search_path = '' as $$
  select regexp_replace(lower(coalesce(p, '')), '[^[:alpha:]]+', '', 'g');
$$;

-- Kilograms already promised on a trip (open or delivered matches).
create function public.trip_used_kg(p_trip bigint)
returns numeric language sql stable security definer set search_path = '' as $$
  select coalesce(sum(s.weight_kg), 0)
    from public.matches m join public.requests s on s.id = m.sender_request_id
   where m.traveler_request_id = p_trip and m.status in ('proposed', 'accepted', 'completed');
$$;

-- Puts a trip back to "waiting" when it has nothing left on it.
create function public.settle_trip(p_trip bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.matches m where m.traveler_request_id = p_trip and m.status in ('proposed', 'accepted')) then
    return;
  end if;
  if exists (select 1 from public.matches m where m.traveler_request_id = p_trip and m.status = 'completed') then
    -- Items already delivered: the trip closes once its flight has left; until then it can take more.
    update public.requests set status = 'delivered' where id = p_trip and status = 'matched' and flight_date < current_date;
  else
    update public.requests set status = 'waiting' where id = p_trip and status = 'matched';
  end if;
end;
$$;

-- Shared checks for pairing an item with a trip (used by create_match and request_trip).
create function public.make_match(p_sender_request bigint, p_traveler_request bigint, p_confirm boolean)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  s        public.requests;
  tr       public.requests;
  s_email  text;
  t_email  text;
  v_id     bigint;
begin
  select * into s  from public.requests where id = p_sender_request   for update;
  select * into tr from public.requests where id = p_traveler_request for update;
  if s.id is null or tr.id is null then raise exception 'match_not_found'; end if;
  if s.role <> 'sender' or tr.role <> 'traveler' then raise exception 'match_wrong_roles'; end if;
  if s.direction <> tr.direction then raise exception 'match_wrong_direction'; end if;
  if public.home_country(s.home_city) <> public.home_country(tr.home_city) then raise exception 'match_wrong_country'; end if;
  if s.status not in ('new', 'waiting') or tr.status not in ('new', 'waiting', 'matched') then raise exception 'match_closed'; end if;
  if exists (select 1 from public.matches m where m.sender_request_id = s.id and m.status in ('proposed', 'accepted')) then
    raise exception 'match_sender_taken';
  end if;

  -- Dates: the item must be ready at least one day before the flight,
  -- and the flight must arrive in time if a "needed by" date is set.
  if tr.flight_date < current_date then raise exception 'match_trip_past'; end if;
  if s.ready_date > tr.flight_date - 1 or (s.needed_by is not null and s.needed_by < tr.flight_date) then
    raise exception 'match_dates';
  end if;
  -- Weight: must fit in the space left on the trip.
  if public.trip_used_kg(tr.id) + s.weight_kg > tr.space_kg then raise exception 'match_no_space'; end if;

  -- Never match someone with themselves.
  if s.user_id = tr.user_id then raise exception 'match_same_account'; end if;
  select lower(u.email) into s_email from auth.users u where u.id = s.user_id;
  select lower(u.email) into t_email from auth.users u where u.id = tr.user_id;
  if lower(s.contact_email) = lower(tr.contact_email)
     or lower(s.contact_email) = coalesce(t_email, '')
     or lower(tr.contact_email) = coalesce(s_email, '')
     or regexp_replace(s.contact_phone, '[^0-9]', '', 'g') = regexp_replace(tr.contact_phone, '[^0-9]', '', 'g') then
    raise exception 'match_same_email';
  end if;
  -- Look-alike names, different cities (at either end) or an item type the
  -- traveler didn't list need an explicit confirmation.
  if not coalesce(p_confirm, false) and (
       public.norm_name(s.contact_name) = public.norm_name(tr.contact_name)
       or lower(btrim(s.city)) <> lower(btrim(tr.city))
       or s.home_city <> tr.home_city
       or (tr.carry_types is not null and not (s.item_type = any (tr.carry_types)))) then
    raise exception 'match_needs_confirm';
  end if;

  insert into public.matches (sender_request_id, traveler_request_id, created_by)
  values (s.id, tr.id, auth.uid())
  returning id into v_id;

  update public.requests set status = 'matched' where id in (s.id, tr.id) and status <> 'matched';
  return v_id;
end;
$$;

-- Admin: pair an item with a trip.
create function public.create_match(p_sender_request bigint, p_traveler_request bigint, p_confirm boolean default false)
returns bigint language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'match_not_admin' using errcode = '42501'; end if;
  return public.make_match(p_sender_request, p_traveler_request, p_confirm);
end;
$$;

-- "Find a traveler": the person who needs something carried picks a trip for
-- their own item. The traveler then accepts or declines, as with admin matches.
create function public.request_trip(p_item bigint, p_trip bigint)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  s  public.requests;
  tr public.requests;
begin
  select * into s  from public.requests where id = p_item;
  select * into tr from public.requests where id = p_trip;
  if s.id is null or s.user_id is distinct from auth.uid() or s.role <> 'sender' then
    raise exception 'not_your_request' using errcode = '42501';
  end if;
  if tr.id is null or tr.role <> 'traveler' then raise exception 'match_not_found'; end if;
  if tr.carry_types is null or not (s.item_type = any (tr.carry_types)) then raise exception 'trip_wont_carry'; end if;
  return public.make_match(s.id, tr.id, true);   -- they chose this traveler knowingly: no extra confirmation
end;
$$;

-- Admin: undo a match that hasn't been handed over yet.
create function public.cancel_match(p_match_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare
  m public.matches;
begin
  if not public.is_admin() then raise exception 'match_not_admin' using errcode = '42501'; end if;
  select * into m from public.matches where id = p_match_id and status in ('proposed', 'accepted') for update;
  if m.id is null then raise exception 'match_not_found'; end if;
  if exists (select 1 from public.requests where id = m.sender_request_id and status = 'handed_over') then
    raise exception 'match_handed_over';
  end if;
  update public.matches set status = 'cancelled', cancelled_at = now() where id = m.id;
  update public.requests set status = 'waiting' where id = m.sender_request_id and status in ('matched', 'accepted');
  perform public.settle_trip(m.traveler_request_id);
end;
$$;

-- ---------- traveler actions ----------
create function public.my_trip_match(p_match_id bigint)
returns public.matches language plpgsql security definer set search_path = '' as $$
declare
  m public.matches;
begin
  select m2.* into m from public.matches m2 join public.requests t on t.id = m2.traveler_request_id
   where m2.id = p_match_id and t.user_id = auth.uid() for update of m2;
  if m.id is null then raise exception 'not_your_trip' using errcode = '42501'; end if;
  return m;
end;
$$;

-- Accept or decline an item the admin proposed for your trip.
create function public.respond_match(p_match_id bigint, p_accept boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  m public.matches := public.my_trip_match(p_match_id);
begin
  if m.status <> 'proposed' then raise exception 'match_not_proposed'; end if;
  if p_accept then
    update public.matches set status = 'accepted', responded_at = now() where id = m.id;
    update public.requests set status = 'accepted' where id = m.sender_request_id and status = 'matched';
  else
    update public.matches set status = 'declined', responded_at = now() where id = m.id;
    update public.requests set status = 'waiting' where id = m.sender_request_id and status = 'matched';
    perform public.settle_trip(m.traveler_request_id);
  end if;
end;
$$;

-- The traveler has the item in hand.
create function public.mark_handed_over(p_match_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare
  m public.matches := public.my_trip_match(p_match_id);
begin
  if m.status <> 'accepted' then raise exception 'match_not_accepted'; end if;
  update public.matches set handed_over_at = now() where id = m.id;
  update public.requests set status = 'handed_over' where id = m.sender_request_id and status = 'accepted';
end;
$$;

-- The recipient gave the traveler the pickup code. Returns 'ok', 'wrong' or 'locked'
-- (after 5 wrong tries; the admin can then mark it delivered by hand).
create function public.confirm_pickup(p_match_id bigint, p_code text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  m     public.matches := public.my_trip_match(p_match_id);
  v_ok  text;
begin
  if m.status <> 'accepted' or m.handed_over_at is null then raise exception 'match_not_handed_over'; end if;
  if m.code_attempts >= 5 then return 'locked'; end if;
  select s.pickup_code into v_ok from public.requests s where s.id = m.sender_request_id;
  if v_ok is null or btrim(coalesce(p_code, '')) <> v_ok then
    update public.matches set code_attempts = code_attempts + 1 where id = m.id;
    return case when m.code_attempts + 1 >= 5 then 'locked' else 'wrong' end;
  end if;
  update public.matches set status = 'completed', completed_at = now() where id = m.id;
  update public.requests set status = 'delivered' where id = m.sender_request_id;
  perform public.settle_trip(m.traveler_request_id);
  return 'ok';
end;
$$;

-- ---------- customer self-service ----------
-- Edit your own request while it's still waiting for a match.
create function public.update_my_request(p_id bigint, p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  r public.requests;
begin
  select * into r from public.requests where id = p_id and user_id = auth.uid() for update;
  if r.id is null then raise exception 'not_your_request' using errcode = '42501'; end if;
  if r.status not in ('new', 'waiting')
     or exists (select 1 from public.matches m where (m.sender_request_id = r.id or m.traveler_request_id = r.id) and m.status in ('proposed', 'accepted')) then
    raise exception 'request_locked';
  end if;
  if p ? 'photo_path' and nullif(p ->> 'photo_path', '') is not null and (p ->> 'photo_path') not like auth.uid()::text || '/%' then
    raise exception 'photo_not_yours';
  end if;
  if (p ? 'flight_date' and (p ->> 'flight_date')::date < current_date)
     or (p ? 'ready_date' and (p ->> 'ready_date')::date < current_date)
     or (nullif(p ->> 'needed_by', '') is not null and (p ->> 'needed_by')::date < current_date) then
    raise exception 'date_in_past';
  end if;
  update public.requests set
    details        = coalesce(p ->> 'details', details),
    city           = coalesce(p ->> 'city', city),
    home_city      = coalesce(p ->> 'home_city', home_city),
    contact_phone  = coalesce(p ->> 'contact_phone', contact_phone),
    flight_date    = case when role = 'traveler' and p ? 'flight_date' then (p ->> 'flight_date')::date else flight_date end,
    space_kg       = case when role = 'traveler' and p ? 'space_kg' then (p ->> 'space_kg')::numeric else space_kg end,
    carry_types    = case when role = 'traveler' and p ? 'carry_types'
                          then (select array_agg(x::public.item_type) from jsonb_array_elements_text(p -> 'carry_types') x)
                          else carry_types end,
    item_type      = case when role = 'sender' and p ? 'item_type' then (p ->> 'item_type')::public.item_type else item_type end,
    weight_kg      = case when role = 'sender' and p ? 'weight_kg' then (p ->> 'weight_kg')::numeric else weight_kg end,
    ready_date     = case when role = 'sender' and p ? 'ready_date' then (p ->> 'ready_date')::date else ready_date end,
    needed_by      = case when role = 'sender' and p ? 'needed_by' then nullif(p ->> 'needed_by', '')::date else needed_by end,
    photo_path     = case when role = 'sender' and p ? 'photo_path' then nullif(p ->> 'photo_path', '') else photo_path end,
    handover_name  = case when role = 'sender' then coalesce(p ->> 'handover_name', handover_name) else handover_name end,
    handover_phone = case when role = 'sender' then coalesce(p ->> 'handover_phone', handover_phone) else handover_phone end,
    pickup_name    = case when role = 'sender' then coalesce(p ->> 'pickup_name', pickup_name) else pickup_name end,
    pickup_phone   = case when role = 'sender' then coalesce(p ->> 'pickup_phone', pickup_phone) else pickup_phone end
  where id = r.id;
end;
$$;

-- Cancel your own request (not once the item is with the traveler).
create function public.cancel_my_request(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare
  r public.requests;
  m record;
begin
  select * into r from public.requests where id = p_id and user_id = auth.uid() for update;
  if r.id is null then raise exception 'not_your_request' using errcode = '42501'; end if;
  if r.status in ('handed_over', 'delivered', 'cancelled') then raise exception 'request_locked'; end if;
  if r.role = 'traveler' and exists (select 1 from public.matches x join public.requests s on s.id = x.sender_request_id
                                     where x.traveler_request_id = r.id and x.status = 'accepted' and s.status = 'handed_over') then
    raise exception 'request_locked';   -- you're already carrying something
  end if;

  update public.requests set status = 'cancelled' where id = r.id;
  for m in select * from public.matches x
            where (x.sender_request_id = r.id or x.traveler_request_id = r.id) and x.status in ('proposed', 'accepted') loop
    update public.matches set status = 'cancelled', cancelled_at = now() where id = m.id;
    if r.role = 'traveler' then
      update public.requests set status = 'waiting' where id = m.sender_request_id and status in ('matched', 'accepted');
    else
      perform public.settle_trip(m.traveler_request_id);
    end if;
  end loop;
end;
$$;

-- ---------- ratings ----------
create table public.ratings (
  id          bigint generated always as identity primary key,
  match_id    bigint not null references public.matches (id) on delete cascade,
  rater_id    uuid not null references auth.users (id) on delete cascade,
  ratee_id    uuid not null references auth.users (id) on delete cascade,
  stars       smallint not null check (stars between 1 and 5),
  comment     text check (char_length(comment) <= 1000),
  created_at  timestamptz not null default now(),
  unique (match_id, rater_id)
);

create function public.rate_match(p_match_id bigint, p_stars integer, p_comment text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_sender   uuid;
  v_traveler uuid;
  v_status   text;
begin
  select s.user_id, t.user_id, m.status into v_sender, v_traveler, v_status
    from public.matches m
    join public.requests s on s.id = m.sender_request_id
    join public.requests t on t.id = m.traveler_request_id
   where m.id = p_match_id;
  if v_status is distinct from 'completed' then raise exception 'rating_not_allowed'; end if;
  if auth.uid() not in (v_sender, v_traveler) then raise exception 'rating_not_allowed' using errcode = '42501'; end if;
  insert into public.ratings (match_id, rater_id, ratee_id, stars, comment)
  values (p_match_id, auth.uid(), case when auth.uid() = v_sender then v_traveler else v_sender end,
          p_stars, nullif(btrim(coalesce(p_comment, '')), ''));
exception when unique_violation then
  raise exception 'rating_exists';
end;
$$;

create function public.user_rating(p_user uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('avg', round(avg(stars)::numeric, 1), 'count', count(*))
    from public.ratings where ratee_id = p_user;
$$;

-- "Find a traveler" search. Anyone may search; results show only a first name,
-- rating, flight date, route and free space (never contact details).
create function public.find_travelers(p_home text, p_dir public.request_dir, p_item public.item_type,
                                      p_needed_by date default null, p_city text default null, p_weight numeric default null)
returns table (trip_id bigint, first_name text, rating jsonb, flight_date date, city text, home_city text,
               space_left numeric, carry_types public.item_type[], same_home boolean, same_city boolean)
language sql stable security definer set search_path = '' as $$
  select t.id, split_part(btrim(t.contact_name), ' ', 1), public.user_rating(t.user_id), t.flight_date, t.city, t.home_city,
         t.space_kg - public.trip_used_kg(t.id), t.carry_types,
         t.home_city = p_home, lower(btrim(t.city)) = lower(btrim(coalesce(p_city, '')))
    from public.requests t
   where t.role = 'traveler' and t.status in ('new', 'waiting', 'matched')
     and t.direction = p_dir
     and public.home_country(t.home_city) = public.home_country(p_home)
     and t.flight_date >= current_date + 1                       -- the item reaches them at least a day before
     and (p_needed_by is null or t.flight_date <= p_needed_by)
     and p_item = any (t.carry_types)
     and t.space_kg - public.trip_used_kg(t.id) >= greatest(coalesce(p_weight, 0), 0.1)
     and (auth.uid() is null or t.user_id <> auth.uid())       -- not your own trips
   order by t.home_city = p_home desc, lower(btrim(t.city)) = lower(btrim(coalesce(p_city, ''))) desc, t.flight_date
   limit 50;
$$;


-- ---------- status page ----------
-- Everything one request's status page needs, for its owner (or an admin).
-- The two sides see each other's contact details only once the traveler
-- has accepted. The pickup code is shown only to the person who posted the item.
create function public.request_details(p_id bigint)
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
             || case when m.status in ('accepted', 'completed') then jsonb_build_object(
                  'traveler_name', t.contact_name, 'traveler_phone', t.contact_phone, 'traveler_email', t.contact_email)
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
                 || case when m.status in ('accepted', 'completed') then jsonb_build_object(
                      'requester_name', s.contact_name, 'requester_phone', s.contact_phone, 'requester_email', s.contact_email,
                      'handover_name', s.handover_name, 'handover_phone', s.handover_phone,
                      'pickup_name', s.pickup_name, 'pickup_phone', s.pickup_phone)
                    else '{}'::jsonb end
                 order by m.created_at)
          from public.matches m join public.requests s on s.id = m.sender_request_id
         where m.traveler_request_id = r.id and m.status in ('proposed', 'accepted', 'completed')), '[]'::jsonb));
  end if;
  return v_out;
end;
$$;

-- ---------- admin notes ----------
create table public.request_notes (
  id          bigint generated always as identity primary key,
  request_id  bigint not null references public.requests (id) on delete cascade,
  author_id   uuid default auth.uid() references auth.users (id) on delete set null,
  body        text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at  timestamptz not null default now()
);
create index request_notes_request_idx on public.request_notes (request_id);

-- ---------- visits (anonymous analytics) ----------
create table public.visits (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  source        text check (char_length(source) <= 80),
  device        text check (device in ('Phone', 'Tablet', 'Desktop')),
  time_zone     text check (char_length(time_zone) <= 64),
  lang          text check (lang in ('en', 'de')),
  duration_s    integer not null default 0 check (duration_s between 0 and 86400),
  form_started  boolean not null default false
);
create index visits_created_at_idx on public.visits (created_at desc);

create function public.start_visit(p_source text, p_device text, p_time_zone text, p_lang text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  insert into public.visits (source, device, time_zone, lang)
  values (left(p_source, 80),
          case when p_device in ('Phone', 'Tablet', 'Desktop') then p_device end,
          left(p_time_zone, 64),
          case when p_lang in ('en', 'de') then p_lang end)
  returning id into v_id;
  return v_id;
end;
$$;

create function public.touch_visit(p_id uuid, p_duration_s integer, p_form_started boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.visits v
     set duration_s   = greatest(v.duration_s, least(greatest(coalesce(p_duration_s, 0), 0), 86400)),
         form_started = v.form_started or coalesce(p_form_started, false)
   where v.id = p_id and v.created_at > now() - interval '24 hours';
end;
$$;

-- ---------- row-level security ----------
alter table public.profiles       enable row level security;
alter table public.requests       enable row level security;
alter table public.request_events enable row level security;
alter table public.matches        enable row level security;
alter table public.ratings        enable row level security;
alter table public.request_notes  enable row level security;
alter table public.visits         enable row level security;

create policy "Profiles: read own or admin" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));
create policy "Profiles: update own" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "Requests: create own" on public.requests for insert to authenticated
  with check (user_id = (select auth.uid()) and status = 'new' and fee_usd is null
              and (role = 'sender' or (select public.has_password())));   -- travelers need a password account
create policy "Requests: read own or admin" on public.requests for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
create policy "Requests: admin updates" on public.requests for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "Events: admin reads"  on public.request_events for select to authenticated using ((select public.is_admin()));
create policy "Matches: admin reads" on public.matches        for select to authenticated using ((select public.is_admin()));
create policy "Ratings: admin reads" on public.ratings        for select to authenticated using ((select public.is_admin()));
create policy "Notes: admin reads"   on public.request_notes  for select to authenticated using ((select public.is_admin()));
create policy "Notes: admin writes"  on public.request_notes  for insert to authenticated with check ((select public.is_admin()));
create policy "Visits: admin reads"  on public.visits         for select to authenticated using ((select public.is_admin()));

-- ---------- table, column and function privileges ----------
revoke all on public.profiles, public.requests, public.request_events, public.matches,
              public.ratings, public.request_notes, public.visits from anon, authenticated;

grant select on public.profiles to authenticated;
grant update (full_name, carry_types) on public.profiles to authenticated;     -- never is_admin

grant select on public.requests to authenticated;
grant insert (role, direction, city, home_city, carry_types, details, contact_name, contact_email, contact_phone, agreed_prohibited, lang,
              flight_date, space_kg, item_type, weight_kg, ready_date, needed_by, photo_path,
              handover_name, handover_phone, pickup_name, pickup_phone)
  on public.requests to authenticated;
grant update (status, fee_usd) on public.requests to authenticated;  -- policy limits this to admins

grant select on public.request_events, public.matches, public.ratings, public.visits to authenticated;  -- policies: admins only
grant select on public.request_notes to authenticated;
grant insert (request_id, body) on public.request_notes to authenticated;

do $$
declare f text;
begin
  -- internal helpers: nobody calls these directly
  foreach f in array array['public.handle_new_user()', 'public.prepare_new_request()', 'public.log_request_status()',
                           'public.touch_updated_at()', 'public.settle_trip(bigint)', 'public.my_trip_match(bigint)',
                           'public.trip_used_kg(bigint)', 'public.make_match(bigint, bigint, boolean)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  -- called from the website by logged-in users (each checks who is calling)
  foreach f in array array['public.is_admin()', 'public.has_password()', 'public.create_match(bigint, bigint, boolean)',
                           'public.cancel_match(bigint)', 'public.respond_match(bigint, boolean)', 'public.mark_handed_over(bigint)',
                           'public.confirm_pickup(bigint, text)', 'public.update_my_request(bigint, jsonb)',
                           'public.cancel_my_request(bigint)', 'public.rate_match(bigint, integer, text)',
                           'public.request_details(bigint)', 'public.user_rating(uuid)', 'public.request_trip(bigint, bigint)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  -- anonymous visit analytics
  foreach f in array array['public.start_visit(text, text, text, text)', 'public.touch_visit(uuid, integer, boolean)',
                           'public.find_travelers(text, public.request_dir, public.item_type, date, text, numeric)'] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end;
$$;

-- ---------- item photos (Supabase Storage) ----------
-- Private bucket, 5 MB per photo. Each user uploads into a folder named
-- after their account id. A photo can be seen by its owner, the admin,
-- and the traveler the item was proposed to.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('item-photos', 'item-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create function public.can_view_photo(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select split_part(p_name, '/', 1) = auth.uid()::text
      or public.is_admin()
      or exists (select 1 from public.requests s
                   join public.matches m on m.sender_request_id = s.id
                   join public.requests t on t.id = m.traveler_request_id
                  where s.photo_path = p_name and t.user_id = auth.uid()
                    and m.status in ('proposed', 'accepted', 'completed'));
$$;
revoke all on function public.can_view_photo(text) from public, anon;
grant execute on function public.can_view_photo(text) to authenticated;

create policy "Item photos: upload into own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'item-photos' and split_part(name, '/', 1) = (select auth.uid())::text);
create policy "Item photos: view" on storage.objects for select to authenticated
  using (bucket_id = 'item-photos' and (select public.can_view_photo(name)));
create policy "Item photos: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'item-photos' and split_part(name, '/', 1) = (select auth.uid())::text);

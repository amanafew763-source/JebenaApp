// Jebena Express — "notify" Edge Function.
//
// Called by the database (supabase/email-notifications.sql):
//   { event: 'insert' | 'update', request_id }        a request was created or its status changed
//   { event: 'match_proposed' | 'match_cancelled', match_id }   an item was proposed to a trip, or that match was undone
// It loads the rows itself, emails the people involved in their language
// (English or German) through Resend, alerts the admin about new requests,
// and records every attempt in the notifications table.
//
// Secrets (Supabase dashboard → Edge Functions → Secrets, or `supabase secrets set`):
//   NOTIFY_WEBHOOK_SECRET  same random value as 'notify_secret' in Vault
//   RESEND_API_KEY         from resend.com → API Keys
//   EMAIL_FROM             e.g. "Jebena Express <updates@yourdomain.com>" (a verified Resend domain)
//   SITE_URL               your live site, e.g. https://jebena-express.pages.dev
//   ADMIN_EMAIL            optional: where new-request alerts go; also the reply-to address
// SUPABASE_URL and the service key are provided by Supabase automatically.

type Env = (key: string) => string;
type Deps = { fetch: typeof fetch; env: Env };
type Lang = 'en' | 'de';

type Req = {
  id: number; created_at: string; role: 'sender' | 'traveler'; direction: 'to_addis' | 'from_addis'; home_city?: string | null;
  city: string; details: string; contact_name: string; contact_email: string; lang: Lang; status: string;
  fee_usd: number | null; flight_date: string | null; space_kg: number | null;
  item_type: string | null; weight_kg: number | null; ready_date: string | null; needed_by: string | null;
};
type Match = { id: number; status: string; sender_request_id: number; traveler_request_id: number };
type Mail = { subject: string; html: string; text: string };

const REQ_COLS = 'id,created_at,role,direction,city,home_city,details,contact_name,contact_email,lang,status,fee_usd,flight_date,space_kg,item_type,weight_kg,ready_date,needed_by';

const TEXT = {
  en: {
    addis: 'Addis Ababa', ref: 'Request', trip: 'Trip', route: 'Route', item: 'Item', weight: 'Weight', ready: 'Ready from',
    neededBy: 'Needed by', flight: 'Flight date', space: 'Space', fee: 'Agreed fee', details: 'Details',
    button: 'Open the status page', hello: 'Hello {name},',
    footer: 'You’re getting this email because you used Jebena Express. Reply to this email if you have questions.',
    types: { clothes: 'Clothes', medicine: 'Medicine', electronics: 'Electronics', documents: 'Documents', food: 'Food', other: 'Other' } as Record<string, string>,
    sender: {
      received: ['We got your request: {route}', 'Thanks for your request. We’ll look for a traveler on this route and email you at every step.'],
      waiting: ['We’re looking for a traveler: {route}', 'Your request is waiting for a traveler on this route. We’ll email you as soon as we find one.'],
      matched: ['We found a traveler: {route}', 'We’ve proposed your item to a traveler on this route. As soon as they accept, you’ll get their contact details to arrange the handover.'],
      accepted: ['The traveler accepted your item', 'Good news: the traveler accepted. Their name and phone number are on your status page so you can arrange the handover. Your pickup code is there too: give it to the person collecting the item.'],
      handed_over: ['Your item is with the traveler', 'The traveler has your item. At pickup, the recipient gives them the pickup code from your status page.'],
      delivered: ['Picked up: {route}', 'The item was picked up and the pickup code confirmed. Thank you for using Jebena Express. You can rate the traveler on your status page.'],
      cancelled: ['Request cancelled: {route}', 'This request has been cancelled. If that’s a mistake, reply to this email and we’ll sort it out.']
    } as Record<string, [string, string]>,
    traveler: {
      received: ['We got your trip: {route}', 'Thanks for offering space on your trip. We’ll email you when we have an item for you to accept or decline.'],
      cancelled: ['Trip cancelled: {route}', 'Your trip has been cancelled. If that’s a mistake, reply to this email.'],
      match_proposed: ['New item for your trip: please accept or decline', 'Someone would like you to carry the item below. Open your status page to see its photo, then accept or decline. Contact details are shared only after you accept.'],
      match_cancelled: ['An item was removed from your trip', 'The item below is no longer on your trip, so you don’t need to carry it.']
    } as Record<string, [string, string]>
  },
  de: {
    addis: 'Addis Abeba', ref: 'Anfrage', trip: 'Reise', route: 'Strecke', item: 'Artikel', weight: 'Gewicht', ready: 'Bereit ab',
    neededBy: 'Benötigt bis', flight: 'Flugdatum', space: 'Platz', fee: 'Vereinbarte Gebühr', details: 'Details',
    button: 'Statusseite öffnen', hello: 'Hallo {name},',
    footer: 'Du bekommst diese E-Mail, weil du Jebena Express nutzt. Antworte einfach auf diese E-Mail, wenn du Fragen hast.',
    types: { clothes: 'Kleidung', medicine: 'Medikamente', electronics: 'Elektronik', documents: 'Dokumente', food: 'Lebensmittel', other: 'Sonstiges' } as Record<string, string>,
    sender: {
      received: ['Deine Anfrage ist eingegangen: {route}', 'Danke für deine Anfrage. Wir suchen eine reisende Person auf dieser Strecke und schicken dir bei jedem Schritt eine E-Mail.'],
      waiting: ['Wir suchen eine reisende Person: {route}', 'Deine Anfrage wartet auf eine reisende Person auf dieser Strecke. Wir melden uns, sobald wir jemanden gefunden haben.'],
      matched: ['Wir haben eine reisende Person gefunden: {route}', 'Wir haben deinen Artikel einer reisenden Person vorgeschlagen. Sobald sie zusagt, bekommst du ihre Kontaktdaten, um die Übergabe zu vereinbaren.'],
      accepted: ['Die reisende Person hat zugesagt', 'Gute Nachricht: Die reisende Person hat zugesagt. Name und Telefonnummer stehen auf deiner Statusseite, damit ihr die Übergabe vereinbaren könnt. Dort findest du auch den Abholcode: Gib ihn der Person, die den Artikel abholt.'],
      handed_over: ['Dein Artikel ist bei der reisenden Person', 'Die reisende Person hat deinen Artikel. Bei der Abholung nennt die empfangende Person den Abholcode von deiner Statusseite.'],
      delivered: ['Abgeholt: {route}', 'Der Artikel wurde abgeholt und der Abholcode bestätigt. Danke, dass du Jebena Express nutzt. Auf deiner Statusseite kannst du die reisende Person bewerten.'],
      cancelled: ['Anfrage storniert: {route}', 'Diese Anfrage wurde storniert. Falls das ein Irrtum ist, antworte auf diese E-Mail, und wir klären das.']
    } as Record<string, [string, string]>,
    traveler: {
      received: ['Deine Reise ist eingegangen: {route}', 'Danke, dass du Platz auf deiner Reise anbietest. Wir melden uns, sobald wir einen Artikel haben, den du annehmen oder ablehnen kannst.'],
      cancelled: ['Reise storniert: {route}', 'Deine Reise wurde storniert. Falls das ein Irrtum ist, antworte auf diese E-Mail.'],
      match_proposed: ['Neuer Artikel für deine Reise: bitte annehmen oder ablehnen', 'Jemand möchte, dass du den Artikel unten mitnimmst. Auf deiner Statusseite siehst du das Foto und kannst annehmen oder ablehnen. Kontaktdaten werden erst nach deiner Zusage geteilt.'],
      match_cancelled: ['Ein Artikel wurde von deiner Reise entfernt', 'Der Artikel unten ist nicht mehr Teil deiner Reise. Du musst ihn nicht mitnehmen.']
    } as Record<string, [string, string]>
  }
} as const;

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
const fill = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
const langOf = (r: Req): Lang => r.lang === 'de' ? 'de' : 'en';
const fmtDate = (d: string | null, lang: Lang) => d ? new Date(d + 'T12:00:00Z').toLocaleDateString(lang === 'de' ? 'de-DE' : 'en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
const fmtKg = (n: number | null, lang: Lang) => n == null ? '' : `${Number(n).toLocaleString(lang === 'de' ? 'de-DE' : 'en-US')} kg`;

// The Ethiopia end of the route (older rows have no home_city: Addis Ababa).
export function routeOf(r: Pick<Req, 'direction' | 'city' | 'home_city'>, lang: Lang) {
  const home = !r.home_city || r.home_city === 'Addis Ababa' ? TEXT[lang].addis : r.home_city;
  return r.direction === 'from_addis' ? `${home} → ${r.city}` : `${r.city} → ${home}`;
}
const statusLink = (siteUrl: string, id: number) => siteUrl ? `${siteUrl.replace(/\/$/, '')}/#r${id}` : '';

// Which customer email a request event should produce, or null for none.
export function kindFor(event: string, r: Pick<Req, 'role' | 'status'>): string | null {
  const kind = event === 'insert' ? 'received' : r.status;
  const table = r.role === 'traveler' ? TEXT.en.traveler : TEXT.en.sender;
  return (kind in table && !kind.startsWith('match_')) ? kind : null;
}

function itemRows(r: Req, lang: Lang): [string, string][] {
  const T = TEXT[lang];
  const rows: [string, string][] = [[T.ref, '#' + r.id], [T.route, routeOf(r, lang)]];
  if (r.item_type) rows.push([T.item, `${T.types[r.item_type] ?? r.item_type}: ${r.details}`]);
  if (r.weight_kg != null) rows.push([T.weight, fmtKg(r.weight_kg, lang)]);
  if (r.ready_date) rows.push([T.ready, fmtDate(r.ready_date, lang)]);
  if (r.needed_by) rows.push([T.neededBy, fmtDate(r.needed_by, lang)]);
  return rows;
}
function tripRows(r: Req, lang: Lang): [string, string][] {
  const T = TEXT[lang];
  return [[T.trip, '#' + r.id], [T.route, routeOf(r, lang)], [T.flight, fmtDate(r.flight_date, lang)], [T.space, fmtKg(r.space_kg, lang)], [T.details, r.details]];
}

function layout(o: { title: string; greeting: string; intro: string; rows: [string, string][]; button?: [string, string]; footer: string }) {
  const rows = o.rows.map(([k, v]) =>
    `<tr><td style="padding:6px 12px 6px 0;color:#6b6157;font-size:14px;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0;font-size:14px;color:#18140f">${esc(v)}</td></tr>`).join('');
  const button = o.button
    ? `<p style="margin:24px 0 0"><a href="${esc(o.button[1])}" style="display:inline-block;background:#0f7a55;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px">${esc(o.button[0])}</a></p>` : '';
  return `<!doctype html><html><body style="margin:0;background:#f2f0eb;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f0eb;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden">
<tr><td style="height:6px;font-size:0;line-height:0;background-color:#0f7a55;background-image:linear-gradient(90deg,#0f7a55 0 40%,#dca843 40% 50%,#b8402f 50% 90%,#dca843 90%)"></td></tr>
<tr><td style="padding:28px 28px 8px"><div style="font-weight:800;font-size:18px;color:#0f7a55">Jebena Express</div>
<h1 style="font-size:22px;line-height:1.25;color:#18140f;margin:18px 0 12px">${esc(o.title)}</h1>
<p style="font-size:15px;line-height:1.55;color:#18140f;margin:0 0 6px">${esc(o.greeting)}</p>
<p style="font-size:15px;line-height:1.55;color:#18140f;margin:0 0 16px">${esc(o.intro)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee7dc;padding-top:8px;width:100%">${rows}</table>
${button}</td></tr>
<tr><td style="padding:20px 28px 28px;font-size:12px;line-height:1.5;color:#8a7f73">${esc(o.footer)}</td></tr>
</table></td></tr></table></body></html>`;
}
function plain(o: { greeting: string; intro: string; rows: [string, string][]; button?: [string, string]; footer: string }) {
  return [o.greeting, '', o.intro, '', ...o.rows.map(([k, v]) => `${k}: ${v}`), '', ...(o.button ? [`${o.button[0]}: ${o.button[1]}`, ''] : []), o.footer].join('\n');
}
function compose(lang: Lang, name: string, pair: [string, string], route: string, rows: [string, string][], link: string): Mail {
  const T = TEXT[lang], subject = fill(pair[0], { route });
  const o = { title: subject, greeting: fill(T.hello, { name }), intro: pair[1], rows, button: link ? [T.button, link] as [string, string] : undefined, footer: T.footer };
  return { subject, html: layout(o), text: plain(o) };
}

// Email to the person who posted a request (item or trip) about its own status.
export function requestEmail(r: Req, kind: string, siteUrl: string): Mail {
  const lang = langOf(r), T = TEXT[lang];
  const traveler = r.role === 'traveler';
  const rows = traveler ? tripRows(r, lang) : itemRows(r, lang);
  if (!traveler && r.fee_usd != null && kind !== 'cancelled') rows.push([T.fee, new Intl.NumberFormat(lang === 'de' ? 'de-DE' : 'en-US', { style: 'currency', currency: 'USD' }).format(Number(r.fee_usd))]);
  return compose(lang, r.contact_name, (traveler ? T.traveler : T.sender)[kind], routeOf(r, lang), rows, statusLink(siteUrl, r.id));
}

// Email to a traveler about one item on their trip.
export function travelerItemEmail(trip: Req, item: Req, kind: 'match_proposed' | 'match_cancelled', siteUrl: string): Mail {
  const lang = langOf(trip), T = TEXT[lang];
  const rows = itemRows(item, lang).filter(([k]) => k !== T.ref);
  rows.unshift([T.trip, '#' + trip.id], [T.flight, fmtDate(trip.flight_date, lang)]);
  return compose(lang, trip.contact_name, T.traveler[kind], routeOf(trip, lang), rows, statusLink(siteUrl, trip.id));
}

export function adminEmail(r: Req, siteUrl: string): Mail {
  const route = routeOf(r, 'en');
  const what = r.role === 'traveler' ? 'trip' : 'item request';
  const subject = `New ${what} #${r.id}: ${route}`;
  const rows: [string, string][] = [['Name', r.contact_name], ['Email', r.contact_email],
    ...(r.role === 'traveler' ? tripRows(r, 'en') : itemRows(r, 'en')), ['Language', r.lang === 'de' ? 'German' : 'English']];
  const o = { title: subject, greeting: 'Hello,', intro: `A new ${what} just came in.`, rows,
    button: siteUrl ? ['Open the admin dashboard', siteUrl] as [string, string] : undefined, footer: 'Sent automatically by your Jebena Express site.' };
  return { subject, html: layout(o), text: plain(o) };
}

function serviceKey(env: Env) {
  const legacy = env('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  try { const keys = JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}'); const first = Object.values(keys)[0]; if (typeof first === 'string') return first; } catch { /* ignore */ }
  return env('SUPABASE_SECRET_KEY');
}
function dbHeaders(key: string) {
  const h: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) h.Authorization = `Bearer ${key}`;   // legacy JWT-style service_role key
  return h;
}
// Constant-time comparison so the secret can't be guessed byte by byte.
function sameSecret(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const { fetch: f, env } = deps;
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!sameSecret(req.headers.get('x-webhook-secret') ?? '', env('NOTIFY_WEBHOOK_SECRET'))) return new Response('Unauthorized', { status: 401 });

  let payload: { event?: string; request_id?: number; match_id?: number };
  try { payload = await req.json(); } catch { return new Response('Bad request', { status: 400 }); }
  const event = String(payload.event || '');
  const base = env('SUPABASE_URL'), key = serviceKey(env);
  const get = async <T>(path: string): Promise<T[] | null> => {
    const res = await f(`${base}/rest/v1/${path}`, { headers: dbHeaders(key) });
    return res.ok ? await res.json() as T[] : null;
  };

  const siteUrl = env('SITE_URL'), from = env('EMAIL_FROM'), apiKey = env('RESEND_API_KEY'), admin = env('ADMIN_EMAIL');
  const jobs: { kind: string; to: string; requestId: number; mail: Mail }[] = [];

  if (event === 'insert' || event === 'update') {
    const id = Number(payload.request_id);
    if (!Number.isInteger(id)) return new Response('Bad request', { status: 400 });
    const rows = await get<Req>(`requests?id=eq.${id}&select=${REQ_COLS}`);
    if (!rows) return new Response('Could not load request', { status: 502 });
    const r = rows[0];
    if (!r) return new Response('Not found', { status: 404 });
    const kind = kindFor(event, r);
    if (kind) jobs.push({ kind, to: r.contact_email, requestId: r.id, mail: requestEmail(r, kind, siteUrl) });
    if (event === 'insert' && admin) jobs.push({ kind: 'admin_new', to: admin, requestId: r.id, mail: adminEmail(r, siteUrl) });
  } else if (event === 'match_proposed' || event === 'match_cancelled') {
    const id = Number(payload.match_id);
    if (!Number.isInteger(id)) return new Response('Bad request', { status: 400 });
    const ms = await get<Match>(`matches?id=eq.${id}&select=id,status,sender_request_id,traveler_request_id`);
    if (!ms) return new Response('Could not load match', { status: 502 });
    const m = ms[0];
    if (!m) return new Response('Not found', { status: 404 });
    const rs = await get<Req>(`requests?id=in.(${m.sender_request_id},${m.traveler_request_id})&select=${REQ_COLS}`);
    if (!rs) return new Response('Could not load requests', { status: 502 });
    const item = rs.find(r => r.id === m.sender_request_id), trip = rs.find(r => r.id === m.traveler_request_id);
    if (!item || !trip) return new Response('Not found', { status: 404 });
    // No "item removed" email when the traveler cancelled the whole trip themselves.
    if (!(event === 'match_cancelled' && trip.status === 'cancelled')) {
      jobs.push({ kind: event, to: trip.contact_email, requestId: trip.id, mail: travelerItemEmail(trip, item, event, siteUrl) });
    }
  } else {
    return new Response('Bad request', { status: 400 });
  }

  const results = [];
  for (const job of jobs) {
    let status = 'sent', error: string | null = null;
    if (!apiKey || !from) { status = 'skipped'; error = 'RESEND_API_KEY or EMAIL_FROM not set'; }
    else {
      try {
        const sent = await f('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to: [job.to], subject: job.mail.subject, html: job.mail.html, text: job.mail.text, ...(admin ? { reply_to: admin } : {}) })
        });
        if (!sent.ok) { status = 'failed'; error = `Resend ${sent.status}: ${(await sent.text()).slice(0, 300)}`; }
      } catch (e) { status = 'failed'; error = String(e).slice(0, 300); }
    }
    await f(`${base}/rest/v1/notifications`, {
      method: 'POST', headers: { ...dbHeaders(key), Prefer: 'return=minimal' },
      body: JSON.stringify({ request_id: job.requestId, kind: job.kind, recipient: job.to, status, error })
    }).catch(() => {});
    results.push({ kind: job.kind, status });
  }
  return new Response(JSON.stringify({ ok: true, results }), { headers: { 'Content-Type': 'application/json' } });
}

// Entry point on Supabase (Deno). Skipped when the file is imported by tests.
const D = (globalThis as { Deno?: { serve: (h: (r: Request) => Promise<Response>) => void; env: { get: (k: string) => string | undefined } } }).Deno;
if (D) D.serve(req => handle(req, { fetch: globalThis.fetch.bind(globalThis), env: k => D.env.get(k) ?? '' }));

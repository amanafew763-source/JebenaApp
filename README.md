# Jebena Express

Jebena Express matches people sending items between **Addis Ababa and the diaspora** with travelers who have spare room in their luggage. The site is in English and German.

It is a static website (HTML, CSS and JavaScript) that talks directly to **Supabase** for accounts and data. There is no server to run.

## How it works

1. **Someone needs something carried**, in either direction: a jacket from Frankfurt to their mother in Addis, or coffee from their brother in Addis to them in Maryland. They describe the item (type, weight, photo), say when it's ready, and name who hands it over and who picks it up. A "That's me" box fills in their own details.
2. **A traveler posts a trip:** flight date, direction, city, and how many kg they can carry.
3. **You match them** on the admin page. Only items that fit are suggested: ready at least one day before the flight, arriving by any "needed by" date, and within the space left.
4. **The traveler accepts or declines** the item on their trip's status page. Only after they accept do both sides see each other's phone numbers.
5. **Handover:** the traveler inspects the item, takes it, and taps "I've received the item".
6. **Pickup:** the recipient tells the traveler a 6-digit **pickup code**, shown only on the requester's status page. The traveler enters it, and the item is marked picked up. After 5 wrong tries the code locks, and you confirm the pickup by hand.
7. **Ratings:** both sides rate each other from 1 to 5 stars.

Every request has a **status page** (`yoursite/#r123`) with a timeline (Posted → Matched → Traveler accepted → Handed to traveler → On the way → Picked up), the item and its photo, the people involved, and buttons to edit (while still waiting), cancel (until the handover) and rate. Every update email links to it.

| Piece | Service | Cost to start |
|---|---|---|
| Code | GitHub | Free |
| Website hosting | Cloudflare Pages | Free |
| Database, accounts, email confirmation | Supabase (EU region) | Free tier |
| Bot protection (optional) | Cloudflare Turnstile | Free |

## What's in this repo

```
index.html              the page
assets/styles.css       design (light and dark mode)
assets/i18n.js          English and German text
assets/app.js           everything that runs in the browser
config.js               your Supabase URL and public key (fill in)
_headers                security headers for Cloudflare Pages
supabase/schema.sql     database tables and access rules (run once)
supabase/make-admin.sql turns your account into an admin
supabase/email-templates/          login-code emails in English and German (step 4)
supabase/email-notifications.sql   email trigger and email log (step 8)
supabase/email-secrets.sql         tells the database where the email function is (step 8)
supabase/functions/notify/index.ts the function that sends the emails (step 8)
```

## How the data is protected

All access rules live in the database (`supabase/schema.sql`), not in the browser:

- Visitors who aren't logged in can only record an anonymous page visit.
- **Senders** sign in without a password: they enter their email and type in a 6-digit code we email them. The account is created automatically.
- **Travelers** need an account with a password. The database refuses traveler requests from accounts without one; senders can set a password later from My account.
- Logged-in users can send requests and see **only their own**.
- Contact details are shared between the two sides **only after the traveler accepts**. The pickup code is visible only to the person who posted the item.
- Item photos are stored privately. Only their owner, the admin, and the traveler the item is proposed to can see them.
- Only admins can see all requests and visits, and change a request's status or fee.
- Nobody can make themselves an admin from the website.
- Each account can send at most 5 requests per hour.
- Matches can only be made by an admin, through a database function that **never pairs a person with themselves**: it refuses two requests from the same account, or with the same email address or phone number on both sides (including the email the accounts were created with). Look-alike names or different cities need an extra confirmation click.
- The forms have a hidden honeypot field and a minimum fill time to stop simple bots.
- Passwords are handled and hashed by Supabase. The site never stores card details.

The public key in `config.js` is designed to be visible. It only allows what the rules above allow. **Never put the `service_role` or secret key in this repo.**

---

## Setup

### 1. Create the Supabase project

1. Sign up at [supabase.com](https://supabase.com) and click **New project**.
2. Pick the region **Central EU (Frankfurt)**, since you have German users and GDPR applies.
3. Choose a strong database password and save it in a password manager.

### 2. Create the tables

1. In your project, open **SQL Editor → New query**.
2. Paste the whole of `supabase/schema.sql` and click **Run**.

You should see "Success. No rows returned." Under **Table Editor** you'll now see `profiles`, `requests` and `visits`.

### 3. Connect the website

1. In Supabase, open **Project Settings → API** (or the **Connect** button at the top).
2. Copy the **Project URL** and the **anon** / **publishable** key.
3. Paste them into `config.js`:

```js
window.JEBENA_CONFIG = {
  supabaseUrl: 'https://abcdefghijklmnop.supabase.co',
  supabaseAnonKey: 'eyJhbGciOi...',
  turnstileSiteKey: ''
};
```

### 4. Email and login settings

1. **Authentication → Sign In / Providers → Email**: make sure it's enabled and **Confirm email** is on.
2. **Authentication → Emails**: by default Supabase emails a link, but senders need the 6-digit code. Replace two templates with the ready-made bilingual (English and German) versions in `supabase/email-templates/`:
   - **Magic Link**: paste `magic-link.html` as the body. Subject: `Your Jebena Express code: {{ .Token }}`
   - **Confirm signup**: paste `confirm-signup.html` as the body (it has both the code and a link). Subject: `Confirm your Jebena Express account`

   Codes are valid for 1 hour, and a new one can be requested once a minute (Supabase defaults).
3. **Authentication → URL Configuration**:
   - **Site URL**: your live address, for example `https://jebena-express.pages.dev` (from step 7).
   - **Redirect URLs**: add the same address, plus `http://localhost:8000/` for testing on your computer.
4. **Before launch:** Supabase's built-in email sender only allows a handful of emails per hour and is meant for testing. Under **Authentication → Emails → SMTP Settings**, connect an email provider with a free tier (for example Resend or Brevo) so confirmation and reset emails always arrive.

### 5. Make yourself the admin

1. Open the site, click **Login**, and sign in with an email code (or create a traveler account with a password).
2. In Supabase, open **SQL Editor**, paste `supabase/make-admin.sql`, replace `you@example.com` with your email, and click **Run**.
3. Log out and back in. An **Admin** link appears in the top bar.

The admin dashboard has two views: **Live data** (real visits and requests from the last 30 days, where you can change each request's status and fee) and **Sample data** (made-up numbers for demos).

**Matching.** In Live data, the **Matching** card lists every upcoming trip, with its flight date and the space left. Under each one you'll see the open items going the same direction that **fit its dates and space**, same city first:

- Click **Match** to propose an item to a trip. The traveler gets an email asking them to accept or decline, and the requester is told a traveler was found.
- A yellow flag (different city, or the same name as the traveler) means the button asks you to click twice, so you look before you confirm.
- Requests from the traveler's own account or email address are hidden and can't be matched, even through the API.
- A trip can carry several items; an item can only be on one trip.
- Items that don't fit the dates or space are counted underneath, not hidden silently.
- **Cancel match** (two clicks) puts the item back to "waiting", and the trip too if it carries nothing else. Once the item is with the traveler, the match can't be cancelled.

**Orders table.** Search by name, email, phone, city or item; filter by status, type and direction; change a status or the agreed fee directly; open **Notes** for private admin notes on any request; and **Export CSV** to download what's shown (also a handy backup on the free plan).

Someone *can* still open a second account with a different email and a different name. The real protection against that is checking travelers' phone numbers and ID, which is the next step on the list.

### 6. Bot protection with Turnstile (optional, recommended before launch)

1. In the Cloudflare dashboard, open **Turnstile → Add widget**, enter your site's domain, and choose **Managed**.
2. Copy the **site key** into `config.js` as `turnstileSiteKey`.
3. In Supabase, open **Authentication → Attack Protection**, enable **CAPTCHA protection**, choose **Turnstile**, and paste the **secret key**.

Requesting an email code, password login, sign-up and password reset will then require the Turnstile check.

### 7. Publish with Cloudflare Pages

1. In the Cloudflare dashboard, open **Workers & Pages → Create → Pages → Connect to Git**.
2. Pick this GitHub repository.
3. Build settings: **Framework preset: None**, **Build command:** leave empty, **Build output directory:** `/`.
4. Click **Save and Deploy**. You'll get an address like `https://jebena-express.pages.dev`.
5. Put that address into Supabase's **Site URL** and **Redirect URLs** (step 4).

From now on, every push to GitHub updates the live site automatically.

> GitHub Pages isn't used for hosting because its terms don't allow running an online business or handling passwords there. GitHub is only used for the code.

### 8. Email updates to customers

Once this is set up, customers get an email in their language (English or German):

| When | Email |
|---|---|
| They send a request or a trip | "We got your request" / "We got your trip" |
| You set the status to **waiting** | "We're looking for a match" |
| You propose an item to a trip | Traveler: "New item for your trip: please accept or decline". Requester: "We found a traveler" |
| The traveler accepts | Requester: "The traveler accepted your item" (contact details are on the status page, never in emails) |
| The traveler confirms the handover | Requester: "Your item is with the traveler" |
| The pickup code is confirmed | Requester: "Picked up" |
| A match is cancelled | Traveler: "An item was removed from your trip" |
| A request is cancelled | The person who posted it |

You also get an email for every new request if you set `ADMIN_EMAIL`. Changing only the fee sends nothing. Every attempt is recorded in the `notifications` table, including the error if one failed.

Emails go out through [Resend](https://resend.com). Its free plan covers 3,000 emails a month and 100 a day.

**a) Resend account and domain.** Sign up at resend.com. To email customers, you need to send from a domain you own and have verified in Resend (**Domains → Add domain**, then add the DNS records it shows). If you don't have a domain yet, Cloudflare Registrar sells them at cost, usually around $10–15 a year, and the DNS records are then one click away. Then create an API key under **API Keys**. You can use the same domain for Supabase's login emails (step 4).

**b) Create the email table and trigger.** In Supabase **SQL Editor**, run `supabase/email-notifications.sql`.

**c) Deploy the function.** From this folder on your computer (needs Node.js):

```bash
npx supabase login
npx supabase functions deploy notify --no-verify-jwt --project-ref YOUR-PROJECT-REF
```

`YOUR-PROJECT-REF` is the part before `.supabase.co` in your Project URL. `--no-verify-jwt` is needed because the database calls this function with its own shared secret, not a user login.

**d) Set the function's secrets.** In Supabase, open **Edge Functions → Secrets** (or use `npx supabase secrets set NAME=value --project-ref ...`) and add:

| Name | Value |
|---|---|
| `NOTIFY_WEBHOOK_SECRET` | a long random string; generate one with `openssl rand -hex 32` |
| `RESEND_API_KEY` | your Resend API key |
| `EMAIL_FROM` | for example `Jebena Express <updates@yourdomain.com>` |
| `SITE_URL` | your live site, for example `https://jebena-express.pages.dev` |
| `ADMIN_EMAIL` | your email: gets new-request alerts and customer replies |

**e) Connect the database to the function.** Open `supabase/email-secrets.sql`, fill in your project ref and the **same** `NOTIFY_WEBHOOK_SECRET` value, and run it in the SQL Editor. Don't commit it with the real values.

**f) Test it.** Send a request on the site and check your inbox. Then change its status on the admin dashboard. If nothing arrives, look at **Table Editor → notifications**: the `error` column says what went wrong (for example, an unverified domain).

## Running it on your computer

Any static file server works. From this folder:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Without `config.js` filled in, the site runs in **demo mode**: you can browse everything, but accounts and requests are switched off and a notice says so.

## Things to know about the free tiers

- **Supabase pauses free projects after 7 days without activity.** Open the dashboard to wake it. Upgrade before you have real customers.
- **The free plan has no automatic backups.** Export your data regularly (**Table Editor → requests → Export to CSV**), or upgrade.
- The free plan includes 500 MB of database storage, 1 GB of file storage and 50,000 monthly active users, which is plenty for launch. Item photos are shrunk in the browser before upload (to at most 1600 px, usually a few hundred KB), so 1 GB holds thousands of them. Limits change, so check Supabase's pricing page.
- The admin dashboard reads up to 1,000 requests and 1,000 visits per 30 days. That's fine for now; a summary view in the database can replace it when you outgrow it.

## Before going live

- [ ] Fill in `config.js` and finish setup steps 1–7
- [ ] Custom SMTP for emails (step 4)
- [ ] Turnstile (step 6)
- [ ] Email updates with a verified domain (step 8)
- [ ] Privacy policy and terms of service pages (GDPR; have a lawyer review them)
- [ ] Replace the example names and numbers in the hero (boarding pass, floating cards)
- [ ] Replace `hello@jebenaexpress.example` with your real contact email
- [ ] Have a native German speaker review the German text
- [ ] To delete a customer's data on request: **Authentication → Users → Delete user** (their requests are deleted with them)

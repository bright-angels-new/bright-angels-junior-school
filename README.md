# Bright Angels Junior School Website

A Cloudflare Workers website with a public school site, a private administrator dashboard, D1-backed content, admissions and parent feedback, R2-backed image uploads, and email notifications through Resend.

## Included
- Responsive public site and the school badge supplied in the earlier project (when available).
- Admission form with child passport photograph upload.
- D1 schema for school settings, announcements, gallery records, and admission applications.
- R2 storage for gallery images and private admission passport images.
- Administrator login restricted to `brightangels26@gmail.com`.
- Parent/guardian feedback form, with private administrator review and deletion.
- Admission and feedback email notifications to `brightangels26@gmail.com` through Resend.
- PBKDF2-SHA256 password verification on the server; no password in browser code.
- Admin controls for school text/contact information, announcements, gallery uploads/deletion, and reviewing/deleting admission records.
- Passport photos are served only through an authenticated admin endpoint.

## Requirements
- Node.js 20+ and npm.
- A Cloudflare account with Workers, D1, and R2 enabled.
- Cloudflare Wrangler CLI, installed through `npm install`.

## Setup and deploy
1. Unzip the project and open a terminal in this folder.
2. Run `npm install`.
3. Sign in to Cloudflare: `npx wrangler login`.
4. This package is already configured to use your existing D1 database `bright-angels-junior-school-db` (ID `137647d1-a64a-4cc0-b3ba-027a9199f7d3`). If that database is not in the Cloudflare account you deploy from, replace the ID and name with your own database values.
5. Create the R2 bucket if it does not already exist: `npx wrangler r2 bucket create bright-angels-school-uploads`.
6. Apply the database migrations: `npm run db:migrate:remote`.
7. Set the administrator email secret: `npx wrangler secret put ADMIN_EMAIL` and enter `brightangels26@gmail.com`.
8. Generate a password hash locally: `npm run hash-password`. Enter the chosen administrator password at the prompt. The supplied password is accepted, but it is short; consider changing it to a longer unique password before production. Copy the printed PBKDF2 string.
9. Set the hash secret: `npx wrangler secret put ADMIN_PASSWORD_HASH` and paste the generated PBKDF2 string.
10. Generate a random session secret locally (example command on macOS/Linux: `openssl rand -hex 32`) and set it with `npx wrangler secret put SESSION_SECRET`.
11. Configure email notifications. Create/verify a sending domain with Resend, then set `RESEND_API_KEY` using `npx wrangler secret put RESEND_API_KEY`. Set `MAIL_FROM` to a sender on that verified domain, for example `Bright Angels Website <website@YOUR-VERIFIED-DOMAIN>`, using `npx wrangler secret put MAIL_FROM`. Resend will not reliably deliver from an unverified domain; the site still saves submissions to D1 if email is not configured, and the dashboard shows them.
12. Test locally with `npm run dev`.
13. Deploy with `npm run deploy`. Cloudflare will return the actual `*.workers.dev` address. The proposed name can be unavailable, so the final assigned address is determined by Cloudflare.

## Domain name
Cloudflare will provide a public `*.workers.dev` address after deployment. A custom domain such as `brightangelsjunior...` must be purchased/owned and attached in Cloudflare DNS; this package cannot reserve a domain name automatically.

## Security notes
- Do not put the plain password or password hash in `public/`, `src/index.js`, or `wrangler.toml`.
- Do not share `SESSION_SECRET`.
- Passport photos are kept in R2 under admission keys and are not exposed as public URLs.
- Public gallery images are served by a public endpoint. Only the authenticated administrator can upload/delete them.
- D1 stores metadata and application fields; R2 stores the binary image files.
- For production, add rate limiting/WAF rules to the login endpoint and establish a school privacy/retention policy for child data.
- Cloudflare deployment and D1/R2 provisioning must be run in the owner's Cloudflare account; this project does not claim to have been deployed from this chat.

## Admin
Open `/admin` is not a separate route in this starter; use the “Administrator” link in the footer to open the protected login dialog. All write APIs check the server-side session and CSRF token.

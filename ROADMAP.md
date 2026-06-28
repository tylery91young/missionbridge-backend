# Mission Bridge — Build Roadmap & Notes

_Last updated: June 24, 2026_

## ⚠️ CRITICAL KNOWN ISSUES (discovered via real testing, must address before wider launch)
- **Email size limits cause silent failures.** SendGrid's Inbound Parse has a hard 30MB total message size limit (text + attachments combined) — this is a platform limit, not fixable by upgrading SendGrid. Confirmed via real test: a long email + 3 large drone photos (~8-10MB each) bounced with "Message too large" / "550 Error reading data, max message size exceeded." The bounce goes to the MISSIONARY's email, not to us — we currently have no way to detect when this happens, so a family could simply never receive an update and never know why.
- **Gmail's own 25MB sending limit compounds this.** Gmail auto-converts attachments to a Google Drive link when total attachments exceed 25MB on the sending side. This means even before hitting SendGrid's limit, Gmail may silently swap a real photo attachment for a Drive link in the email body — which our system currently CANNOT capture, since we only process actual file attachments, not links inside email text. This is a separate, real failure mode from the SendGrid size bounce.
- **Realistic risk level:** lower than it first seemed — normal phone photos (2-4MB each) in reasonable quantities (a handful per email) stay well under these limits. The failure mode requires either unusually large files (like raw/high-res drone photos) or a missionary attaching many photos in one email. Still a real, inevitable edge case once enough real missionaries use this regularly.
- **We cannot reliably auto-detect the SendGrid bounce** — it happens upstream of our webhook, before SendGrid even processes the message, so there's no event we can hook into to know it happened.
- **A "direct upload page" was considered as a fix but is NOT confirmed feasible** — unknown whether missionaries have general web browser access on their phones, or are restricted to specific approved apps only (Gmail, Google Photos, official missionary app). Need to verify with a current/recent missionary before building anything that assumes browser access.
- **Google Drive link auto-fetch is NOT practical to build reliably** — even if a Drive link is public, programmatically scraping content from Google's hosted pages is fragile, could break anytime Google changes their page structure, and risks looking like the kind of automated access Google actively tries to block. Decided NOT to build automatic retrieval of Drive-link content.
- **Decided fix instead: detect Drive links in email body text and flag them clearly on the dashboard** so the family knows to manually save it before it's gone, rather than silently losing it. (See "Drive link detection email" below — now planned.)

## 🔜 NEXT SESSION / IN-PROGRESS WORK
(all items below were completed this session - see DONE list)


## ✅ DONE (live and working)
- Landing page live on Cloudflare Pages/Workers
- Backend live on Render: missionbridge-backend.onrender.com
- GitHub repo: github.com/tylery91young/missionbridge-backend
- SendGrid Inbound Parse set up — catches all mail to *@parse.getmissionbridge.com
- PostgreSQL database on Render (persists emails, attachments metadata, waitlist, missionaries, expenditures)
- Cloudflare R2 bucket (missionbridge-photos) — permanent photo storage, confirmed working
- Webhook captures email text + photo attachments + voice memos, uploads to R2, saves everything to DB
- Mimetype detection with extension fallback (handles audio/photo correctly even with generic mimetypes)
- Real signup form on website (missionary email x2 + family email + phone + expected return date), with clear date labeling
- Missionary/family email pairing — incoming emails matched to registered missionary automatically
- Customer-facing dashboard (dashboard.html) — chronological view, filters (photos/audio/text), individual + bulk downloads, lightbox photo viewer, mobile responsive
- Individual + whole-update delete (soft-delete, reversible) with confirmation warnings on the customer dashboard
- Link-sharing permission toggle ("allow downloads when this link is shared") — hides download/delete buttons for shared-link viewers when off
- Admin dashboard (admin.html) — password protected, overview stats (customers, revenue, expenditures, net profit, storage %, system health), full customer table with editable paid amount + notes, kick/restore customer (reversible), direct link to view any customer's dashboard
- Expenditure tracking on admin dashboard (add/view/remove business costs, factored into net profit)
- Photo/Google rescue guide (photo-guide.html) — Partner Sharing setup steps, Takeout backup instructions, post-return checklist
- Find-my-dashboard recovery flow — emails the dashboard link rather than displaying it directly (security fix), generic response regardless of match to avoid leaking which emails are in the system
- Business email set up: tyler@getmissionbridge.com (Cloudflare Email Routing, forwards to personal Gmail), used as sender for transactional emails via SendGrid
- Terms of Service page (terms.html) — covers service scope, 6-month minimum post-return access commitment, specific money-back promise tied to actual data loss, liability boundaries
- Lightweight "I agree to Terms" checkbox added to signup form
- All website/dashboard copy cleaned up: removed em dashes and awkward hyphens, "updates" changed to "emails," homepage step 3 corrected to honestly reflect actual storage policy (no longer claims indefinite free storage)
- 80 survey responses collected and analyzed (final batch, survey closed)
- First weekly BYU grant report submitted
- Real user test completed (mom) — surfaced and fixed: signup date clarity, storage/liability concerns, link-sharing permission need
- Logo concepts in progress (hand-coded SVG, not AI-generated, per grant/IP guidance)
- Final logo locked in and live on all six pages (Golden Gate-style bridge, 5/8 crop, full wordmark, sized correctly with no clipping)
- Dashboard email body text bug fixed (was inheriting center alignment, now explicitly left-aligned)
- Signup page now includes an honest "what this saves" scope note (emails, voice memos, attached photos — not Drive/Photos links, practical email size limits)
- Terms of Service updated with explicit "What Mission Bridge Cannot Save" section covering email size limits and Drive link limitations
- Google Drive/Photos link detection built into the webhook — flags any incoming email containing a Drive or Photos link
- Automatic alert email sent to the family when a Drive link is detected, explaining the limitation and recommending they save it themselves + ask the missionary to attach files directly going forward
- Dashboard now shows a visible warning banner on any email where a Drive link was detected
- Welcome email now sent automatically after signup (short, personal, from Tyler, with contact email and a reassuring tone)
- Documented real findings on email size limits (SendGrid 30MB Inbound Parse cap, Gmail 25MB send threshold before auto-converting to Drive links) via live testing
- Email log added to admin dashboard — every transactional email (welcome, Drive link alerts, dashboard recovery) is now logged with recipient, type, success/failure, and error message if failed. Shows total failure count prominently.
- Dashboard view tracking added — every dashboard load is logged, admin can see total views and last-viewed time per missionary, giving real engagement visibility (not just signups, but actual usage)
- Upgraded link detection from a single generic flag to structured categories: Drive file link, Photos album link, both, and whether the email was "mostly just a link" with little written content. Dashboard now shows the SPECIFIC issue to the family (not generic), and a new admin "Detected Content Issues" table shows all of these across every customer for pattern-spotting over time.

## 🔜 NEXT SESSION PRIORITIES
1. **Render plan check** — current free tier spins down when inactive ("turns off and everything stops working"). Need to evaluate if this is acceptable for first real testers or if upgrading is necessary before launch.
2. **Admin: expenditure tracking** — add a way to log/track business costs (hosting, domain, etc.) on the admin dashboard, not just revenue
3. **Admin: kick/remove a customer** — with a warning/confirmation step before actually removing them
4. **Customer dashboard: delete items** — let customers delete individual emails/photos/audio from their own archive, with a warning/confirmation step first
5. **Better signup flow** — turn current single-form signup into a proper multi-step signup screen/flow, and send a real confirmation email upon signup (actual email automation, not just a webpage message)
6. **Website messaging shift** — change copy to "looking for testers" / explicitly free for now, so the live site can be handed directly to testers without confusion about pricing
7. **Update survey data analysis** — incorporate the new 80-response batch (up from 62) into pricing/demand confidence

## 🔜 LATER (not urgent, but tracked)
- **AI usage boundaries (clarify before next asset creation)** — Tyler flagged that AI-generated logos may not be allowed for the business (possibly a BYU grant compliance issue, possibly broader IP/legal caution). Need to check BYU's actual grant terms on this specifically. Until clarified: don't use AI image generation for the logo or other brand assets representing the business; stick to human-made or licensed design work for anything that functions as an official brand mark.
- **Welcome email to families after signup** — currently the success screen on the website shows the next steps, but no actual email is sent. Worth adding a simple "welcome to Mission Bridge" email with their dashboard link and next steps, sent automatically right after signup. (Mailer module already exists for find-dashboard, easy to reuse.)
- **Dashboard link security limitation (known, accepted for now)** — dashboard links currently use the missionary's plain email in the URL with no further verification. Anyone with the link has full access, including the ability to toggle the "allow downloads" sharing permission back on, even if the original family turned it off. This is "obscurity" not real security. Real fix requires the bigger "real accounts with an owner vs. viewer distinction" build already noted below. Acceptable for founding-tester phase; revisit before wider launch if sharing/trust concerns come up again.
- **Soft-delete storage cleanup** — "deleted" photos/emails/audio are currently just hidden (is_deleted flag), not actually removed from R2/database. This means storage keeps growing even from "deleted" items. Not worth solving now — R2 free tier is huge and this is a non-issue for at least ~2 years at current scale — but eventually worth either a periodic cleanup job or a "permanently delete" option once storage actually starts to matter.
- **Pricing model decision (refined)** — Two options: (1) One-time fee (~$75, slightly cheaper overall) includes a generous storage cap and access through mission + 6 months per ToS. (2) Monthly fee (~$8/mo) keeps the dashboard active only while actively paying; if a family wants storage/access kept going longer than the one-time plan's included window, the monthly option naturally allows that since it's pay-as-you-go. Real storage costs are negligible either way (~$0.05-1.32 per missionary for a full mission, confirmed via cost modeling), so pricing is about psychology/value framing, not actual cost coverage.
- **Auto-generated scrapbook PDF** — Tyler's idea: at end of mission, auto-format everything (all emails + photos) into a large, beautifully laid out PDF, sellable as a printable add-on. Bigger build (needs real PDF layout/design engine), separate from the simpler "keepsake book" pricing already validated (~$75-80 avg in survey data). Worth scoping once core product is proven with real testers.
- **Mission-ended automated trigger** — currently nothing happens when expected_return_date passes. Eventually should auto-email the family pointing to the photo-rescue guide and any future scrapbook/keepsake offering. Not urgent — current testers' missionaries have a long time left.
- Automate the "guide" send — currently the photo-guide.html page exists but nothing emails/texts it automatically based on expected_return_date. Needs a scheduled job + real email/SMS sending (e.g. SendGrid for email, Twilio for text) once ready to automate.
- Keepsake/memory book feature (shelved for now, validated demand exists — $50-150 price range)
- Consider non-Latin character support (Korean, Japanese) in saved emails — flagged by a survey respondent
- Real payment processing (Stripe) — not yet built; admin "paid amount" field is currently manual entry only
- LLC + business bank account — do this once charging real strangers (not founding testers) for real
- **Full link-sharing permission levels** — currently built: simple on/off toggle for downloads+deletes when link is shared. A true Dropbox-style system (multiple permission tiers, revocable per-person access) would require real user accounts/logins — bigger future build if ever needed.

## 💡 STRATEGY NOTES
- Target: ~600 customers/year ≈ $45-48k/year revenue, most of which is profit given low infra costs
- Go-to-market: founding families first (offer free/cheap to ~10-15 of the 19+ warm survey leads), NOT paid ads — cold Facebook ads likely lose money at this price point based on CAC math
- Money-back guarantee idea: make it specific — "if we lose a single email or photo, full refund" — directly targets the core fear validated in survey data
- Distribution channels that matter most: wards, mission prep groups, missionary mom Facebook groups — word of mouth in a tight community beats ads here
- Traction grant ($2k) — still worth applying for, but for infra scaling / founding-family discounts, not ad spend

### Founding tester offer (Phase 1 — keep this simple)
- Free or heavily discounted for the first ~10-15 testers (pull from the 19+ warm survey leads)
- In exchange: honest feedback + permission to use them as a reference/testimonial later
- No referral mechanics yet — zero friction, just get real happy users fast

### Referral system (Phase 2 — after product is proven, NOT for founding testers)
- Once out of founding/testing phase, offer pricing choice:
  - Pay $100 standard, OR
  - Tag Mission Bridge on their ward Facebook page for a discount (e.g. $10) or free, OR
  - Get a personal referral link: pay $100, get $10 back for every signup that uses their link (and encourage them to post it on their ward/mission Facebook groups)
- Requires building real referral-code tracking into the backend first (doesn't exist yet) — don't bolt this onto early testers, give it a proper clean rollout
- This is the actual word-of-mouth engine once there's real momentum to amplify

## 📌 OPEN QUESTIONS / DECISIONS PENDING
- Voice memo: transcribe or just archive as-is?
- When to officially end "waitlist" framing and start real signups?

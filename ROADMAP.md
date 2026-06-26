# Mission Bridge — Build Roadmap & Notes

_Last updated: June 22, 2026_

## ✅ DONE (live and working)
- Domain registered: getmissionbridge.com (Cloudflare)
- Landing page live on Cloudflare Pages/Workers
- Backend live on Render: missionbridge-backend.onrender.com
- GitHub repo: github.com/tylery91young/missionbridge-backend
- SendGrid Inbound Parse set up — catches all mail to *@parse.getmissionbridge.com
- PostgreSQL database on Render (persists emails, attachments metadata, waitlist, missionaries)
- Cloudflare R2 bucket (missionbridge-photos) — permanent photo storage, confirmed working
- Webhook captures email text + photo attachments + voice memos, uploads to R2, saves everything to DB
- Mimetype detection with extension fallback (handles audio/photo correctly even with generic mimetypes)
- Real signup form on website (missionary email x2 + family email + phone + expected return date)
- Missionary/family email pairing — incoming emails matched to registered missionary automatically
- Customer-facing dashboard (dashboard.html) — chronological view, filters (photos/audio/text), individual + bulk downloads, lightbox photo viewer, mobile responsive
- Admin dashboard (admin.html) — password protected, overview stats (customers, revenue, storage %, system health), full customer table with editable paid amount + notes, direct link to view any customer's dashboard
- Photo/Google rescue guide (photo-guide.html) — Partner Sharing setup steps, Takeout backup instructions, post-return checklist
- 80 survey responses collected (up from 62 last update)

## 🔜 NEXT SESSION PRIORITIES
1. **Render plan check** — current free tier spins down when inactive ("turns off and everything stops working"). Need to evaluate if this is acceptable for first real testers or if upgrading is necessary before launch.
2. **Admin: expenditure tracking** — add a way to log/track business costs (hosting, domain, etc.) on the admin dashboard, not just revenue
3. **Admin: kick/remove a customer** — with a warning/confirmation step before actually removing them
4. **Customer dashboard: delete items** — let customers delete individual emails/photos/audio from their own archive, with a warning/confirmation step first
5. **Better signup flow** — turn current single-form signup into a proper multi-step signup screen/flow, and send a real confirmation email upon signup (actual email automation, not just a webpage message)
6. **Website messaging shift** — change copy to "looking for testers" / explicitly free for now, so the live site can be handed directly to testers without confusion about pricing
7. **Update survey data analysis** — incorporate the new 80-response batch (up from 62) into pricing/demand confidence

## 🔜 LATER (not urgent, but tracked)
- **Soft-delete storage cleanup** — "deleted" photos/emails/audio are currently just hidden (is_deleted flag), not actually removed from R2/database. This means storage keeps growing even from "deleted" items. Not worth solving now — R2 free tier is huge and this is a non-issue for at least ~2 years at current scale — but eventually worth either a periodic cleanup job or a "permanently delete" option once storage actually starts to matter.
- **Storage time limit / renewal pricing** — Terms of Service now states 6 months post-return access guaranteed, with notice before any discontinuation. Still need to decide and build: exact pricing for extending access beyond that window. Ties into the original one-time-fee-forever cost concern an engineer raised early on.
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

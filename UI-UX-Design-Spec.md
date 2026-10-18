# Club Rent Tracker – UI/UX Design Spec (v1 draft)

Clickable prototype: `ui-ux-prototype.html` (open in browser or preview; use the left panel to jump between screens and the Collector / Member toggle to switch views).

---

## 1. Goal

One shared app for the club so that:
- The **collector** (one friend) records monthly ৳200 payments from Cash or bKash in seconds.
- **Every friend** can see who has paid, who is due, and who has posted a "can't pay" note.
- Full **payment history and unpaid months** are kept for every member.

## 2. Users & roles

| Role | Who | Can do |
|---|---|---|
| **Collector** (Admin) | Tanvir (sample) | Record payments, see all, add/remove members, export reports |
| **Member** | All other friends | See the club board, see own history, post "can't pay" note, see pay-to details |

Only numbers added by the collector can log in.

## 3. Business rules (as understood – to confirm)

- Monthly share: **৳200 per member**, fixed.
- Payment methods: **Cash** or **bKash**. For bKash the **Transaction ID is required**.
- Status per member per month:
  - **Paid** (green) – payment recorded.
  - **Due** (red) – not paid and no note.
  - **Won't pay** (amber) – member posted a note. *The amount still counts as due until paid.*
  - **Upcoming** (grey) – future month.
- Unpaid months **accumulate** and stay in the ledger until paid.
- Notes are **visible to all members**.
- Payments and notes are logged in an **activity log** (who did what, when).

## 4. Screen inventory

| # | Screen | Purpose | Key elements |
|---|---|---|---|
| 1 | Login | Phone + OTP sign-in | Phone input, 4-digit OTP |
| 2 | Home (Collector) | Month at a glance | Month switcher, collected vs expected bar, Paid/Due/Won't pay tiles, "Collect payment" button, Needs-attention list, recent activity |
| 2b | Home (Member) | Own status + club board | Own status card (Paid / Due / Won't pay), "I can't pay this month" button, pay-to info, club board |
| 3 | Members | Month status for everyone | Month switcher, filter chips (All / Paid / Due / Won't pay), member rows with status pill |
| 4 | Member profile | Full history | Totals (paid, outstanding, months unpaid), 12-month grid, notes & remarks, payment history with TrxID, "Record payment" |
| 5 | Collect payment (sheet) | Record a payment | Member select (shows dues), month select (unpaid only), fixed ৳200, Cash/bKash toggle, TrxID field |
| 6 | "Can't pay" note (sheet) | Member posts remark | Month, reason chips, optional promise date, free-text note |
| 7 | Dues & ledger | All-time overview | Total outstanding, member list with unpaid-month chips, Excel/PDF export |
| 8 | Settings / My account | Admin settings or member profile | Monthly share, methods, add member, roles, activity log (collector); own totals and pay-to info (member) |

**Navigation:** bottom tabs – Home · Members · Dues · Me. Profile and sheets open on top of the tabs.

## 5. Core user flows

**A. Collector records cash payment**
Home → "Collect payment" → pick member (names with dues shown first) → pick month → Cash → Confirm → toast "Payment recorded" → Members list updates.

**B. Collector records bKash payment**
Same as A, but choose bKash → enter TrxID (required) → Confirm.

**C. Member can't pay this month**
Home → "I can't pay this month" → pick month → reason chip → optional promise date → note → Save → status changes to amber "Won't pay" on everyone's board.

**D. Member checks the club**
Members tab → filter "Due" or "Won't pay" → tap a name → see 12-month record and notes.

**E. Collector checks overall dues**
Dues tab → sorted list of unpaid months per member → export to Excel/PDF.

## 6. Design system (initial)

- **Colors:** Primary `#0F766E` (teal green) · Paid `#16A34A` · Due `#DC2626` · Won't pay `#D97706` · Background `#F6F8F7`
- **Typography:** System UI font (Bangla-capable). Titles 20px bold, body 14px, captions 12px.
- **Shape:** Cards radius 18px, buttons 14px, chips fully rounded.
- **Touch targets:** minimum 44px.
- **Money format:** `৳200`, `৳1,400` (taka symbol, comma grouping).
- **Dates:** `18 Oct 2026` (day month year).
- **Language:** English UI for v1, Bangla labels ready for v2.

## 7. Data model (for development)

```
Member      { id, name, phone, role: collector|member, is_active, joined_on }
Payment     { id, member_id, for_month (YYYY-MM), amount, method: cash|bkash,
              bkash_trx_id?, received_on, recorded_by, created_at }
Remark      { id, member_id, for_month, reason, text, promise_date?, created_at }
ActivityLog { id, actor_id, action, target, created_at }
```
Month status is derived: Payment exists → Paid; else Remark exists → Won't pay; else (past month) → Due; future → Upcoming.

## 8. Questions to confirm before development

1. **Extra charges:** Is ৳200 the only monthly amount (no tea/electricity/extra fees)?
2. **Collector as member:** Does the collector also pay ৳200 like others? (Prototype assumes yes.)
3. **Privacy:** Should members see each other's payment *method and TrxID*, or only Paid / Due / Won't pay?
4. **Won't pay still due:** Confirm that a "Won't pay" month still counts as due until paid.
5. **Reminders:** Do you want automatic reminders (push notification / SMS) on the 1st and 10th of each month?
6. **bKash:** Manual TrxID entry is planned (bKash's automatic payment API needs a merchant account). OK?
7. **Platform:** Android only (APK), or Android + iPhone? Online app with shared database (recommended) or offline?
8. **Language:** English only, or English + Bangla from day one?
9. **Receipts:** Do you want a shareable payment receipt (image/PDF) for each payment?
10. **Multiple collectors:** Should there be a backup collector who can also record payments?
11. **Club name & branding:** Do you have a club name or logo to put on the app?
12. **Member count:** Is the club fixed at 10 members, or will it grow?

## 9. Next steps after your confirmation

1. Finalize the design with your feedback (colors, screens, rules).
2. Choose tech stack (e.g., Flutter or React Native + Firebase/Supabase for shared data and login).
3. Build the MVP: login, members, collect payment, history, "can't pay" notes, dues ledger.
4. Test with the group, then release (APK / Play Store / App Store).

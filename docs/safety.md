# Rider and driver safety

Issue #12. The minimum safety path before real rides: what a rider or driver can do during and after a
trip, what happens to a report, who can block or suspend someone, how urgent reports are escalated, and
what the screens do and do not promise.

**This is an engineering policy, not a legal one.** It decides how the software behaves. Anything that
depends on the place the service runs (emergency numbers, duties to report, how long records must or may
be kept, what a blocked person must be told) is marked **needs-human** below and is left alone.

## What a rider or driver can do

| Where | What |
|---|---|
| Rider trip screen, driver trip screen | A **Safety** button while the trip is under way (scheduled through in progress) and for 7 days after it ends. It opens the safety panel. |
| The safety panel | First, the emergency guidance (below). Then a report: pick what happened, add up to 200 characters, send. Reporting the other person is the same form for both roles: a rider reports the driver, a driver reports the rider. |
| After the trip | The existing **Report a problem** button opens a dispute (money, route, conduct). It is not a safety report; the Safety button is. |

Categories: **urgent** `emergency` ("I need urgent help"), `assault` (violence or a physical threat),
`impaired`; **standard** `unsafe_driving`, `harassment`, `discrimination`, `vehicle_mismatch`, `other`.
The server decides urgency from the category. The reporter cannot lower it and the app cannot override it.

### Emergency guidance and its limits

The panel always shows, above the form and before anything else:

> If you are in immediate danger, contact your local emergency services now. Do not wait for a reply from us.
>
> LoopRide is not an emergency service. We cannot call emergency services for you, send help to your
> location or tell you how quickly staff will see a report.

The wording (`SAFETY_COPY` in `web/src/lib/safety.ts`) is deliberately neutral. It names no number and
promises no response time, because the app has no staffed 24-hour channel, no server-side sender to page
anyone, and does not know where in the world a trip is. After sending, an urgent report says again that
it is not a substitute for emergency services. The app does not call, text or locate on the person's
behalf, and does not share the rider's own location (it never reads it).

## What a report keeps

`submit_safety_report` writes, in one transaction:

1. `safety_reports`: who reported, in which role, who it is about, the category, the server-set urgency,
   the note, and the trip's phase, start, end and outcome and vehicle class. Kept after account deletion
   (audit).
2. `safety_report_snapshots`: the pickup and drop-off addresses, driver name and plate, and the driver's
   last shared position with its time, **as they were at that moment** (the live position is deleted when the
   trip ends and the trip can be erased). Kept 30 days; deleted with the rider's account.
3. For an urgent report, an `ops_escalations` row (level `safety`) opened in the reporter's name, so it
   also shows under **Escalations** and in the **Audit** trail.

The app confirms a report by reading it back (`list_my_safety_reports`); the server silently ignores a
report it refuses (not a participant, trip ended over 7 days ago, unknown category, rate limit), so a
send that is not recorded is shown as failed rather than as sent. A retry with the same key files once.

Abuse limit: at most 5 standard reports per person per hour. Urgent categories are never limited.

## Who sees a report

Staff with the `ops` role see the **Safety** tab: category, urgency, roles, the trip's phase and the
report text. Names, addresses, plates and coordinates are **not** shown. `ops_pii` staff can open them
(**Show details**) after choosing a reason; that logs the person, the time and the reason (`ops_access_log`,
10 minutes) and addresses and coordinates are separate scopes (`trip_pii`, `evidence`). A staff member
never sees, resolves or acts on a report they filed, are the subject of, or that is on their own trip.

## Urgent escalation policy

| Step | Who | Target |
|---|---|---|
| Urgent report filed | the server | opens a `safety` escalation immediately; appears first in the Safety tab |
| Acknowledge | any `ops` staff member (**Acknowledge**) | **within 5 minutes**, or the `safety_unacknowledged` alert fires (critical, on the Health tab) |
| First action | the person who acknowledged | follow the [safety incident runbook](runbooks/safety-incident.md): contact, decide whether to cancel the trip, suspend or block |
| Resolve | a staff member with a resolution code and a note | resolving also resolves the linked escalation. Resolved reports cannot be reopened |

The 5-minute figure is a target the software measures, not a service promise to riders: **nothing pages
anyone**, so it only works while someone is watching the console. A 24-hour on-call arrangement, and
whether the service may operate without one, is a decision for a human (see below).

## Blocking and suspension policy

| Who | Action | Effect | Not affected |
|---|---|---|---|
| Driver | `ops_suspend_driver` (reason `safety` among others, note required) | off dispatch, open offer withdrawn, cannot go available. Reinstated only by `ops_reinstate_driver` | a trip already under way |
| Rider | `ops_block_rider` (reason `safety`, `abuse`, `fraud_suspected`, `other`; note required; may cite the report) | `request_dispatch` and `accept_quote` refused; open driver offers withdrawn; a search in progress cancelled. Lifted by `ops_lift_rider_block` | a trip already under way |

- Both are audited with the actor, time, reason and note (Audit tab). A person cannot suspend, block or
  reinstate themselves.
- A trip under way is cancelled separately (`ops_cancel_trip`, reason `safety_incident`); the choice is the
  staff member's, because stopping a vehicle mid-trip can itself be unsafe.
- A rider block is kept in `rider_block_log` and survives account deletion, so deleting the account and
  starting again does not lift it. A blocked rider sees "Your account can't request rides right now.
  Contact support if you think this is a mistake." The app has no appeal form; support is the route.
- Blocking is a person's decision. Nothing blocks or suspends automatically from a report or a count of reports.

## Needs a human decision

These were not decided here. The code keeps the behaviour above and does not pick a policy.

1. **Emergency wording per jurisdiction.** Whether the guidance should name an emergency number, whether
   "contact your local emergency services" is acceptable in each place, and what must be said about what
   the platform can and cannot do. Review `SAFETY_COPY` before launching in any region.
2. **Out-of-hours cover.** Who watches the Safety tab at what hours, whether the service may take rides
   when nobody does, and whether urgent reports need a pager or phone line (not built; needs a
   server-side sender).
3. **Reporting to authorities.** When staff must or may refer a report to police or a regulator, who decides,
   and what is disclosed. The resolution code `referred_externally` only records that it happened.
4. **Retention** of `safety_reports` and `rider_block_log` (kept after deletion today), and of
   `safety_report_snapshots` (30 days; a longer hold may be needed for a report referred onward).
5. **The reported person's rights**: whether they may see a report or the block, be told of it, and what
   appeal route a blocked rider or suspended driver must be given.
6. **Subject-access export** of snapshots and of reports about a person (a reporter's export lists only
   their own reports).
7. **Background checks, trip sharing with a trusted contact, in-app calling and recording.** Not built and
   not decided; each has legal and privacy consequences.
8. **Whether categories are right** for each place (for example discrimination law differs).

These are also listed per data class in [privacy.md](privacy.md#needs-a-human-decision).

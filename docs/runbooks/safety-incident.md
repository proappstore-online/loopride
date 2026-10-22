# Runbook: safety incident

Use when `safety_unacknowledged` is firing, a safety escalation is open, or someone tells you a rider or
driver is unsafe. Policy and what is left undecided: [safety](../safety.md).

**If anyone is in immediate danger, the first step is emergency services, not this console.** The app
cannot call them for anyone. If the person who reported can be reached by a channel you have, tell them to
contact local emergency services. Do not delay that while you work through the steps below.

## 1. Acknowledge (within 5 minutes)

Operations → **Safety**. Urgent reports are first. Press **Acknowledge** as soon as someone is on it; that
records you and the time and clears the alert. You cannot act on a report you filed, are the subject of, or
that is on your own trip; hand it to someone else.

## 2. Understand it

- Read the category, the roles, the note and the trip phase. Trips tab → search the trip id for the
  timeline, offers and location evidence (no names or coordinates).
- Need the addresses, the driver's name or plate, or the driver's last position? **Show details**, choose
  the reason `safety_incident`. This is logged with your name; the position is a separate tick and a
  separate log. Snapshots exist for 30 days after the report.
- Look at the other person's history in Audit (filter by the trip id, or by a staff member) for earlier
  suspensions, blocks and escalations.

## 3. Contain

| Situation | Action |
|---|---|
| A trip is under way and continuing is unsafe | Trips → **Cancel trip**, reason `safety_incident`, no fee. This is your call: stopping a moving vehicle can itself be unsafe. |
| The driver may be a danger | Safety tab → **Suspend driver** (reason `safety`, a note). They go off dispatch at once. |
| The rider may be a danger | Safety tab → **Block rider**. They cannot request rides; their open offers and search are withdrawn. |
| You are unsure | Do neither yet; escalate (step 4) and note why. Neither suspension nor a block is automatic. |

## 4. Escalate

An urgent report already opened a `safety` escalation (Escalations tab). If it needs a lead, legal, a
regulator or the press, use **Escalate** on the trip or driver with the right level and reason. Someone
other than the person who opened it must resolve an escalation. Whether and when to involve police or a
regulator is not decided in the software: follow the owner's instruction, and record any referral with the
resolution `referred_externally`.

## 5. Resolve

**Resolve** with a resolution code (no action, warned, driver suspended, rider blocked, referred, could not
substantiate, duplicate) and a note that says what you did and why. Resolving also resolves the linked
escalation. A resolved report cannot be reopened; file a new escalation if something new appears. Do not put
names, phone numbers or addresses in the note.

## 6. After

- Lift a block or reinstate a driver only with a reason and a note (Safety → blocked riders; Drivers →
  Reinstate). Both are audited.
- If several reports name the same person, or `safety_unacknowledged` fired because nobody was watching,
  tell the owner: that is a staffing question, not a software one.
- The app tells the reporter their report was sent, but there is no messaging back to them and their
  screen does not show its outcome. Contact them through support if you need to.

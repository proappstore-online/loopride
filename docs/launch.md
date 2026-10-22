# Launch governance and readiness

Issue #18. RideShare moves real people. This page is the gate between "a demo or pilot" and "a service the
public can rely on". It records what must be true, who is accountable, what proves it and who approved it.

**Nothing on this page has been approved.** The engineering the earlier issues asked for is built and
tested, but the gates below are decisions and commitments only people can make: insurance, local law,
screening, tax, terms, support. They are written here as open, with no owner and no evidence, because
inventing either would make the checklist look finished when it is not.

## The rule: demo or pilot until every critical gate is approved

- The product is limited to a **demo or pilot** until **every gate marked critical** is `approved`.
- `LAUNCH_STAGE` in `web/src/lib/launch.ts` is `pilot`. While it is, every screen shows the pilot notice
  ("RideShare is running as a limited pilot... no payment is taken"). A test (`web/src/lib/launch.test.ts`)
  fails the build if it is set to `public` while a critical gate is open, so moving it is a reviewed change.
- "Pilot" means: a small, named set of riders and drivers who know it is a pilot, in places and hours
  the owners have approved (see `transport-rules`, `insurance`, `support`), with the dispatch switch ready.
  Who is in the pilot, and where, is itself a decision for the owners; the software does not enforce a
  place or an invite list.
- A non-critical gate can be open at launch with the owner's written acceptance of the risk.

## How a gate is approved

A gate in [`launch-gates.json`](launch-gates.json) moves `not_started` → `in_progress` → `ready_for_approval`
→ `approved`. It may be `approved` only when it has **all** of:

1. an accountable **owner**: one named person (not a team), who answers for it and keeps the evidence current;
2. **evidence**: references to documents, records or test runs that prove the "evidence required" text
   (a link or a file path, never "done");
3. an **approver** other than the owner, and the **date** of approval.

The test enforces this for every gate. Evidence that expires (insurance, licences, tax registrations) is
reviewed on the date its owner sets; an expired item moves the gate back to `in_progress`.

## Gates

| Gate | What | Critical | Status | Owner | Evidence |
|---|---|---|---|---|---|
| `insurance` | Insurance covers rides, riders, drivers and the platform | Yes | not started | _unassigned_ | _none yet_ |
| `transport-rules` | Local transport rules are satisfied in every place of operation | Yes | not started | _unassigned_ | _none yet_ |
| `driver-screening` | Driver screening is defined, run and recorded | Yes | not started | _unassigned_ | _none yet_ |
| `taxes` | Tax treatment of fares, fees and payouts is decided and set up | Yes | not started | _unassigned_ | _none yet_ |
| `payments` | Money movement is approved, or the pilot is confirmed free of it | Yes | not started | _unassigned_ | _none yet_ |
| `terms` | Terms of service for riders and drivers are written, reviewed and shown | Yes | not started | _unassigned_ | _none yet_ |
| `privacy-policy` | The privacy notice and every open privacy decision are approved | Yes | not started | _unassigned_ | _none yet_ |
| `safety-policy` | Safety policy, emergency wording and escalation are approved | Yes | not started | _unassigned_ | _none yet_ |
| `support` | Support coverage, hours and contact are in place | Yes | not started | _unassigned_ | _none yet_ |
| `operations` | Staff are trained and the runbooks have been rehearsed | Yes | not started | _unassigned_ | _none yet_ |
| `reliability` | The live end-to-end matrix is running and green after deploys | Yes | not started | _unassigned_ | _none yet_ |
| `accessibility` | Accessibility and mobile checklist run on real devices | No | not started | _unassigned_ | _none yet_ |
| `rollback-comms` | Rollback and rider/driver communication plan is approved and rehearsed | Yes | not started | _unassigned_ | _none yet_ |
| `incident-ownership` | Incident ownership and regulator/press contact are named | Yes | not started | _unassigned_ | _none yet_ |

## What each gate needs

### `insurance`: Insurance covers rides, riders, drivers and the platform

- **Why it is a gate.** Real people are carried in real vehicles. Which cover applies (driver personal, commercial, per-trip, platform liability) depends on place and arrangement.
- **Evidence required to approve.** Policy documents or broker confirmation for each place and vehicle use, with limits, named insured and dates; who is notified of a claim.
- **What the repository already provides.** Nothing. The app does not hold or check insurance.
- **Depends on.** none

### `transport-rules`: Local transport rules are satisfied in every place of operation

- **Why it is a gate.** Many places license ride-hailing operators, vehicles and drivers, and restrict fares, areas or vehicle types.
- **Evidence required to approve.** A written determination by someone qualified for each place: licences required, held or not needed, conditions, and the places the service may operate. The app is limited to those places.
- **What the repository already provides.** Nothing. The app does not restrict by place.
- **Depends on.** none

### `driver-screening`: Driver screening is defined, run and recorded

- **Why it is a gate.** Approval today checks only that a licence number, region, expiry and a vehicle were supplied and a staff member approved. No background, identity, licence or vehicle-inspection check is made.
- **Evidence required to approve.** The screening standard (identity, licence verification, criminal and driving record, vehicle inspection, re-check interval) per place, who performs it, and a sample record for each approved driver.
- **What the repository already provides.** Driver application and staff approval workflow (#4); suspension (#12). Not the checks themselves.
- **Depends on.** #4, #12

### `taxes`: Tax treatment of fares, fees and payouts is decided and set up

- **Why it is a gate.** ADR 0001 left the tax rate, who collects and remits it, and driver tax reporting undecided. The ledger records a rate of zero.
- **Evidence required to approve.** An accountant's or adviser's written treatment per place: rates, who is liable, registrations, invoice and receipt wording, driver reporting duties; the policy version set in the ledger.
- **What the repository already provides.** Immutable fare ledger and receipts (#9). No money is collected or paid out.
- **Depends on.** #9

### `payments`: Money movement is approved, or the pilot is confirmed free of it

- **Why it is a gate.** No payment is collected and no driver is paid (ADR 0001). The platform rule against in-app payments needs an explicit decision before real fares exist.
- **Evidence required to approve.** Either the platform's written decision and a provider integration with refunds and disputes tested, or a recorded decision that the pilot charges nothing and what riders and drivers are told.
- **What the repository already provides.** Ledger, receipts and refund-request records (#9, #11). Executing refunds waits on payments.
- **Depends on.** #9

### `terms`: Terms of service for riders and drivers are written, reviewed and shown

- **Why it is a gate.** The app contains no terms and asks nobody to accept any.
- **Evidence required to approve.** The reviewed terms text for riders and for drivers, the version identifier, where and when each person accepts, and where acceptance is recorded.
- **What the repository already provides.** Nothing. There is no terms screen or acceptance record.
- **Depends on.** none

### `privacy-policy`: The privacy notice and every open privacy decision are approved

- **Why it is a gate.** docs/privacy.md lists decisions that are legal choices and were left open: retention of audit and financial records, subject-access scope, jurisdiction, age, inactive accounts.
- **Evidence required to approve.** The published privacy notice, and for each "needs a human decision" item in docs/privacy.md and docs/safety.md a recorded decision or an accepted risk; the data-protection contact.
- **What the repository already provides.** Inventory, consent, retention, export and erasure (#13). Every open item is marked needs-human.
- **Depends on.** #13

### `safety-policy`: Safety policy, emergency wording and escalation are approved

- **Why it is a gate.** The emergency guidance is deliberately jurisdiction-neutral and has not been reviewed for any place. Nothing pages anyone for an urgent report.
- **Evidence required to approve.** Review of SAFETY_COPY for each place; the out-of-hours arrangement (who watches the Safety tab and when); the rule for referring reports to authorities; the appeal route for blocks and suspensions.
- **What the repository already provides.** Safety button, reports, escalation, blocks and runbook (#12). Alert after 5 minutes.
- **Depends on.** #12

### `support`: Support coverage, hours and contact are in place

- **Why it is a gate.** Riders and drivers need a way to reach a person, and staff need to be present while rides run. The app has no support contact or hours.
- **Evidence required to approve.** Named staff with roles (ops, ops_pii), hours of cover matched to the hours rides are allowed, the support contact shown to users, and a dry run of the safety incident runbook.
- **What the repository already provides.** Operations console, audit, runbooks (#11, #15).
- **Depends on.** #11, #15

### `operations`: Staff are trained and the runbooks have been rehearsed

- **Why it is a gate.** Runbooks exist but nobody has used them under pressure.
- **Evidence required to approve.** A record of a rehearsal for dispatch outage, rollback and safety incident, who took part, what was fixed afterwards.
- **What the repository already provides.** Runbooks and the Health tab (#15).
- **Depends on.** #15

### `reliability`: The live end-to-end matrix is running and green after deploys

- **Why it is a gate.** The matrix needs four test accounts that do not exist yet.
- **Evidence required to approve.** The PAS_E2E_* secrets set, a green run of every journey (including the slow one) on the deployed app, and who is told when it fails.
- **What the repository already provides.** Matrix, report and fake API (#17).
- **Depends on.** #17, #15

### `accessibility`: Accessibility and mobile checklist run on real devices (not critical)

- **Why it is a gate.** Automated checks pass; nobody has used the app with VoiceOver or TalkBack.
- **Evidence required to approve.** The completed manual checklist in docs/accessibility.md with device, OS and date, and the issues found.
- **What the repository already provides.** Accessibility work and checklist (#14).
- **Depends on.** #14

### `rollback-comms`: Rollback and rider/driver communication plan is approved and rehearsed

- **Why it is a gate.** docs/launch.md documents the steps and draft messages; nobody has approved the wording or confirmed the channels reach people.
- **Evidence required to approve.** Approved message texts, the channels actually available, who sends, and a rehearsal of pausing dispatch and returning to pilot.
- **What the repository already provides.** Dispatch pause, rollback runbook, pilot limit (this issue).
- **Depends on.** #15

### `incident-ownership`: Incident ownership and regulator/press contact are named

- **Why it is a gate.** Someone must own an incident, decide what to tell people and deal with a regulator or the press.
- **Evidence required to approve.** The incident owner and deputy, the contact for regulators and press, and the escalation order.
- **What the repository already provides.** Escalation levels lead, safety and legal in the console (#11).
- **Depends on.** #11

## Rollback: returning to a pilot or stopping

Launch is reversible at three levels. Use the smallest that works. The mechanisms exist today; who may
decide to use them, and when, is the `incident-ownership` gate.

| Level | When | How | Effect |
|---|---|---|---|
| 1. Pause new rides | an outage, a safety concern, no staff cover | Operations → Health → Dispatch switch → Pause dispatch ([dispatch outage](runbooks/dispatch-outage.md)) | new requests and quote acceptances are refused with a clear message; rides under way, tracking and notifications continue. Audited. |
| 2. Stop individuals | a driver or rider is a risk | suspend a driver, block a rider ([safety](safety.md)) | takes them out of dispatch or stops their requests; rides under way are cancelled separately by staff. |
| 3. Roll the release back | a bad deploy | [rollback runbook](runbooks/rollback.md): revert the commit; the deploy re-registers `mcp.json` and re-applies migrations (additive only) | previous behaviour returns; data is untouched. |

Return to demo: pause dispatch (level 1), then set `LAUNCH_STAGE` back to `pilot` if it had been changed. Rides
under way are finished or cancelled by staff with a reason (`ops_cancel_trip`, no fee) and every affected
person is told (below). Nothing is deleted by a rollback; erasure is a separate act on request
([privacy](privacy.md)).

## Communicating with riders and drivers

### What the product can do today

- **Everyone, always:** the pilot notice on every screen; the pause message when dispatch is paused
  ("New ride requests are paused for a short time while we fix a problem...").
- **People with a ride or trip under way:** in-app notifications and push when a trip is cancelled by staff,
  and the status shown on the trip screen ([notifications](domain-model.md)). Push reaches only people who
  allowed it and have a device registered.
- **Not available:** there is no broadcast, email list, SMS or status page. Reaching people who are not
  in the app needs a channel the owners choose. This is part of the `rollback-comms` gate.

### Who sends what

| Moment | Audience | Sender | Channel |
|---|---|---|---|
| Dispatch paused or resumed | riders and drivers in the app | on-call staff member | pause message (automatic); notice text if the pause is long |
| A trip is cancelled by staff | that rider and driver | the staff member who cancels | automatic notification; follow-up by support |
| Incident affecting safety | affected people, then the regulator if required | incident owner | direct contact; regulator route is a legal decision |
| Rolling back a release | none unless behaviour changed | release owner | in-app notice only if the change was visible |
| Returning to demo | pilot participants | incident owner | the channel agreed in the `rollback-comms` gate |

### Draft messages (wording to be approved; they make no legal claim)

These are starting texts, not approved copy.

- **Pause.** "New ride requests are paused for a short time while we fix a problem. If you have a ride under
  way it is not affected. Please try again in a few minutes."
- **A trip cancelled by us.** "We cancelled your ride. You have not been charged. If you are stranded or
  unsafe, contact local emergency services first; then tell us what happened so we can help."
- **Driver told to stop.** "Your driver account is paused while we review a report. This is not a final
  decision. Contact support to talk it through." (The appeal route is open, see `safety-policy`.)
- **Returning to demo.** "RideShare is moving back to a limited pilot. New rides are paused. Existing trips
  can be finished. We will tell you here when that changes."

Every message that mentions money, safety, law or a person's account standing is reviewed by the gate owner
before first use.

## Keeping this page honest

- `launch-gates.json` is the source of truth; the table above must list every gate (a test checks).
- Open decisions elsewhere ([privacy](privacy.md#needs-a-human-decision), [safety](safety.md#needs-a-human-decision),
  [ADR 0001](adr/0001-fare-collection-payouts-receipts.md)) are referenced by the gates `privacy-policy`,
  `safety-policy`, `taxes` and `payments`; closing the gate means closing those items.
- When a gate's owner changes, update the JSON and this table in the same commit.

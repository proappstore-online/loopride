# Runbook: notification outage

Use when `notification_failures`, `notifications_undelivered` or `notification_error_rate` is firing, or
riders and drivers say they are not hearing about driver arrival, assignments, cancellations or offers.

## How delivery works (so you know what "down" can mean)

Every event writes the notification row itself, in the same transaction. The in-app inbox (the bell, and
toasts while the app is open) is therefore always correct and does not depend on any outside service.
Push is sent by the **app of the person whose action caused the event** (the driver tapping "I've
arrived" sends the rider's push) through the platform's `notifyUser`. There is no server-side sender.
Push is retried 3 times (30 s, then 2 min) and email fallback, for people who opted in, follows when push
finally fails. Full detail: [retries and idempotency](../reliability.md).

## 1. Work out which part is broken

Health shows the two notification alerts and the notification error rate. The individual failed and undelivered notifications (kind, status and error text, never the message) come from the `ops_list_notification_issues` action, which has no screen yet: the app owner can call it through the PAS MCP tools.

| Symptom | Cause | Action |
|---|---|---|
| `notification_failures` firing (pushes failed after 3 attempts) | the platform's push service, VAPID keys, or recipients' subscriptions are failing | step 2 |
| `notifications_undelivered` firing, few failures | the person whose action caused them has not opened the app again since (they close it after tapping), so nothing has tried to send | step 3 |
| `notification_error_rate` firing | the notification actions (inbox, preferences, delivery reports) are failing: a service problem | [dispatch outage](dispatch-outage.md) step 1 |
| Riders get push late | the rider-side delivery list is only worked while the *sender's* app is open | expected; see step 3 |

## 2. Push service failing

1. Open the PAS console logs for the app and look at category `loopride.notification` (`push_not_delivered`, details are redacted). A burst of "no push delivered" means no device received it (unsubscribed or expired subscriptions); a burst of platform errors or HTTP 429 means the platform limits (30 per minute per sender, 10 per minute per recipient) or an outage.
2. Check the platform status (`https://api.proappstore.online/health`).
3. Nothing is lost: the in-app inbox still has every notification and the bell shows it. For people who opted into email fallback, critical events fall back to email once push has failed for good.
4. If the cause is the platform, wait; if it is a deploy, [roll back](rollback.md).

## 3. Undelivered because the sender went away

Nothing to repair. The delivery waits and is sent the next time that person opens the app; the rider
still sees the event in the app within 15 seconds of opening it. If it matters (a driver arrived and the
rider is looking at nothing), support can phone the rider. This is the known limit of having no
server-side sender and is the reason an alert exists rather than an automatic fix.

## 4. Tell people

In-app notifications are the reliable channel. Support's message during a push outage: open the app and
check the bell. Do not promise email: it is only sent to people who opted in and only after push failed.

## 5. Recover

1. Confirm `notification_failures` clears and a test ride delivers a push (sign in on two devices).
2. Failed deliveries (status `failed`) are not retried again automatically; they are still in each
   person's inbox, which is enough.

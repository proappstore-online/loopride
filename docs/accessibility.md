# Accessibility and mobile readiness

Issue #14. What the core ride path promises on a phone and with assistive technology, how it is checked
automatically in CI, and the checklist a person runs on real devices before a release.

## What the app commits to

| Area | Commitment | Where it lives |
|---|---|---|
| Zoom and reflow | Pinch zoom is never disabled; screens fit 375 px wide with no sideways scroll | `web/index.html` viewport, header rows wrap |
| Touch targets | Every button, select, text field, tab, radio and the map's attribution button is at least 44 x 44 px; a checkbox or radio is hit through its 44 px label | `web/src/index.css` |
| Keyboard | The core ride path works without a mouse; focus is always visible (3 px ring); a "Skip to content" link is the first stop; changing screen moves focus to the content and sets the page title from the heading | `web/src/index.css`, `web/src/App.tsx` |
| Landmarks and headings | One `main` landmark, one `h1` per screen | `App.tsx`, each view |
| Address entry | Pickup and destination are labelled combobox fields: type, arrow keys through suggestions, Enter to pick, Escape to close; the number of suggestions is announced | `components/AddressInput.tsx` |
| Choices | Booking mode and ride option expose pressed/checked state, not only colour; quotes are a radio group | `NewRide.tsx`, `QuotePicker.tsx` |
| Live updates | The trip status headline and notifications are polite live regions; errors are `role="alert"`; the offer countdown is not announced every second | `Trip.tsx`, `DriverTrip.tsx`, `Toaster.tsx` |
| Maps | The map is a labelled region; the same pickup, drop-off, driver (name, plate, how fresh their location is) and ETA are listed as text beside it | `components/MapAlternative.tsx`, `TripMap.tsx` |
| Colour | Muted text is at least 4.5:1 on the page and on the tinted panels; state is never shown by colour alone | `index.css` tokens |
| Motion | `prefers-reduced-motion` switches animation and transitions off | `index.css` |

## Automated checks (run in CI)

The `test` workflow runs both on every push and pull request.

1. **Component tests** (`pnpm test`): axe-core (WCAG 2.1 A and AA, `web/test/axe.ts`) over the rendered rider and
   driver trip screens in every phase, the request flow in all three booking modes, home, the driver offers, and
   the safety panel; plus keyboard tests for the address combobox and the driver's accept button.
2. **Browser tests at 375 px** (`pnpm test:e2e`, `web/e2e/accessibility.spec.ts`): for home, plan a ride, driver home,
   driver onboarding, account, a saved trip with its map and the not-found page: axe in Chromium (includes colour
   contrast), no horizontal scroll, every visible control at least 44 px, pinch zoom allowed, one `main`, a skip
   link first in the tab order; plus a tab walk of the home screen that checks each stop shows a focus ring.
3. **This checklist exists** (`web/src/docs.test.ts`) so it cannot be deleted without CI noticing.

Automated checks find roughly a third of accessibility problems. They do not replace the manual pass below.

## Manual mobile checklist (before each release)

Run on at least one iPhone with VoiceOver and one Android phone with TalkBack, on the deployed preview. Tick each
line; record device, OS and date in the release notes.

### Request a ride
- [ ] Zoom to 200% on the home and request screens; nothing is cut off or overlaps, and nothing scrolls sideways.
- [ ] With the screen reader, "Where to?" is announced as a button and its meaning is clear.
- [ ] Type a pickup: suggestions are announced ("N suggestions available"); you can pick one with the screen reader and with a keyboard.
- [ ] Get quotes: each ride option reads as name, price and whether drivers are nearby; the selected one is announced as selected.
- [ ] The price countdown does not interrupt the reader every second.
- [ ] A failed or expired quote is announced as an error.
- [ ] Every control is easy to hit one-handed; no accidental taps on neighbours.

### Track and cancel
- [ ] The status ("Dana is on the way") is announced when it changes, without moving focus.
- [ ] The route details list (pickup, drop-off, driver, ETA) gives the same information as the map; you can complete the trip without ever seeing the map.
- [ ] The map region has a spoken description and does not trap swiping.
- [ ] Cancel ride: the fee is read out before you confirm; focus lands sensibly on the panel and back.
- [ ] The Safety panel opens with the emergency guidance first; sending a report is confirmed aloud.

### Driver
- [ ] A new offer is found by the screen reader; Accept and Decline are reachable and labelled; the time left is readable on request.
- [ ] Each step button ("I've arrived", "Start trip") is announced with the result.
- [ ] Location sharing state is stated in words.

### Everywhere
- [ ] Dark mode and the system "larger text" setting still look right.
- [ ] With "reduce motion" on, nothing animates.
- [ ] Landscape works; the notch and home indicator do not cover controls.
- [ ] Sign-in and sign-out can be completed with the screen reader.
- [ ] Slow network (throttled 3G): loading states are announced; nothing jumps.

## Known limits

- Map tiles are images from OpenStreetMap; the text route details are the accessible equivalent, not a description of the tiles.
- Staff screens (Operations) are covered by the axe component tests but have not had a manual screen-reader pass.
- Native-app features (haptics, system share sheet, installable-PWA behaviour on every browser) are not part of this pass.

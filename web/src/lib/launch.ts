/**
 * How far RideShare is cleared to go (issue #18). The product is limited to a demo or pilot until every
 * critical launch gate in docs/launch-gates.json is approved by a person with an owner and evidence.
 * `launch.test.ts` fails the build if this is changed to 'public' while any critical gate is open, so
 * moving it is a reviewed act, not a drive-by edit.
 */
export type LaunchStage = 'pilot' | 'public'

export const LAUNCH_STAGE: LaunchStage = 'pilot'

export const PILOT_NOTICE = {
  title: 'Pilot',
  body: 'RideShare is running as a limited pilot. Rides, drivers and support may be limited or unavailable, and no payment is taken.',
} as const

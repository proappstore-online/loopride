/**
 * The live journey matrix (issue #17). One entry per journey that must not regress, with the issues
 * that own the behaviour it exercises. A failing journey is reported against these issues
 * (report.mjs) and the ids are in the test titles, so the Playwright output, the results summary
 * and the job summary all say who to send the failure to. docs/e2e-matrix.md is the readable version.
 */
export interface Journey {
  id: string
  title: string
  /** GitHub issues in proappstore-online/loopride that own the behaviour. The first is the primary owner. */
  issues: number[]
  /** Needs a second approved driver. */
  needsSecondDriver?: boolean
  /** Waits minutes of real time; runs only when E2E_SLOW=1. */
  slow?: boolean
}

export const JOURNEYS: Journey[] = [
  { id: 'J1', title: 'request to completion', issues: [6, 5, 7, 8, 9] },
  { id: 'J2', title: 'no driver is available', issues: [5, 6] },
  { id: 'J3', title: 'decline and re-dispatch', issues: [5], needsSecondDriver: true },
  { id: 'J4', title: 'rider cancellation frees the driver', issues: [7, 5] },
  { id: 'J5', title: 'stale GPS is reported honestly', issues: [8] },
  { id: 'J6', title: 'stale GPS raises the alert', issues: [8, 15], slow: true },
  { id: 'J7', title: 'rider safety report reaches staff', issues: [12, 11] },
  { id: 'J8', title: 'driver suspension removes them from dispatch', issues: [11, 4, 12] },
]

export const tag = (j: Journey) => `${j.id} ${j.title} [${j.issues.map((n) => `#${n}`).join(' ')}]`

import { initPro } from '@proappstore/sdk'
import { installTelemetry } from './telemetry'

export const app = initPro({ appId: 'loopride' })

installTelemetry(app)

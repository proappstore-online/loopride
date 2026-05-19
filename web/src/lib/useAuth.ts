import { useProAuth } from '@proappstore/sdk/hooks'
import { app } from './app'

export function useAuth() {
  return useProAuth(app)
}

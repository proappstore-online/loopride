import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach } from 'vitest'
import { cleanup } from '@testing-library/react'

class MemoryStorage implements Storage {
  private store = new Map<string, string>()
  get length(): number {
    return this.store.size
  }
  clear(): void {
    this.store.clear()
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value))
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null
  }
}

const install = (target: object, instance: Storage) => {
  Object.defineProperty(target, 'localStorage', {
    value: instance,
    writable: true,
    configurable: true,
  })
}

const storage = new MemoryStorage()
install(globalThis, storage)
if (typeof window !== 'undefined') install(window, storage)

beforeEach(() => {
  storage.clear()
})

afterEach(() => {
  cleanup()
  storage.clear()
})

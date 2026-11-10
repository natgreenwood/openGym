// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { warmStoreImports } from './warm-store.js'

vi.mock('../lib/api.js', () => ({ api: vi.fn(async () => { throw new TypeError('Failed to fetch') }), setRemoteAuth: vi.fn() }))

// A loaded store adds its focus, storage and pagehide listeners; the warm-up must add none, or it
// would leave a store no clean-up knows about.
it('loads the store\'s imports without loading a store', async () => {
  const onWindow = vi.spyOn(window, 'addEventListener')
  const onDocument = vi.spyOn(document, 'addEventListener')
  await warmStoreImports()
  expect(onWindow).not.toHaveBeenCalled()
  expect(onDocument).not.toHaveBeenCalled()
}, 30000)  // the cold load this helper exists to take out of other files' tests

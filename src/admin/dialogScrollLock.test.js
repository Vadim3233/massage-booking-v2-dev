import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireBodyScrollLock, resetBodyScrollLockForTests } from './dialogScrollLock.js'

describe('admin dialog scroll lock', () => {
  let previousDocument

  beforeEach(() => {
    previousDocument = globalThis.document
    globalThis.document = { body: { style: { overflow: 'auto' } } }
    resetBodyScrollLockForTests()
  })

  afterEach(() => {
    resetBodyScrollLockForTests()
    globalThis.document = previousDocument
  })

  it('keeps the body locked until the last nested dialog releases it', () => {
    const releaseDetails = acquireBodyScrollLock()
    const releaseConfirmation = acquireBodyScrollLock()

    expect(document.body.style.overflow).toBe('hidden')
    releaseConfirmation()
    expect(document.body.style.overflow).toBe('hidden')
    releaseDetails()
    expect(document.body.style.overflow).toBe('auto')
  })

  it('restores the original overflow even when nested cleanup order is reversed', () => {
    const releaseDetails = acquireBodyScrollLock()
    const releaseConfirmation = acquireBodyScrollLock()

    releaseDetails()
    expect(document.body.style.overflow).toBe('hidden')
    releaseConfirmation()
    expect(document.body.style.overflow).toBe('auto')
  })

  it('ignores duplicate releases', () => {
    const release = acquireBodyScrollLock()
    release()
    release()
    expect(document.body.style.overflow).toBe('auto')
  })
})

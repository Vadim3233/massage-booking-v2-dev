import { describe, expect, it } from 'vitest'
import { assistantDestination } from './aiConnector.js'

describe('where an assistant sends the client back to', () => {
  it('knows Claude, ChatGPT and Google Gemini by their own addresses', () => {
    expect(assistantDestination('https://claude.ai/api/mcp/auth_callback')).toEqual({ host: 'claude.ai', known: true, label: 'Claude (claude.ai)' })
    expect(assistantDestination('https://chatgpt.com/connector_platform_oauth_redirect')).toMatchObject({ known: true, label: 'ChatGPT (chatgpt.com)' })
    expect(assistantDestination('https://oauth-redirect.googleusercontent.com/r/abc')).toMatchObject({ known: true, label: 'Google Gemini (oauth-redirect.googleusercontent.com)' })
    expect(assistantDestination('https://oauth-redirect-sandbox.googleusercontent.com/r/abc')).toMatchObject({ known: true })
  })
  it('accepts an assistant on the client\'s own computer', () => {
    expect(assistantDestination('http://127.0.0.1:9/callback')).toMatchObject({ known: true, label: 'the assistant on this computer' })
    expect(assistantDestination('http://localhost:33418/callback')).toMatchObject({ known: true })
  })
  it('refuses anything else, whatever the assistant calls itself', () => {
    expect(assistantDestination('https://evil.example/callback')).toEqual({ host: 'evil.example', known: false })
    expect(assistantDestination('https://claude.ai.evil.example/cb')).toMatchObject({ known: false })
    expect(assistantDestination('https://script.googleusercontent.com/macros/x')).toMatchObject({ known: false })
    expect(assistantDestination('http://claude.ai/cb')).toMatchObject({ known: false })
    expect(assistantDestination('myapp://callback')).toEqual({ host: 'myapp://callback', known: false })
    expect(assistantDestination(undefined)).toEqual({ host: '', known: false })
  })
})

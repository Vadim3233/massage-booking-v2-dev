import { originOf, resourceMetadata } from '../server/aiConnector/mcp.js'

// Where an AI assistant learns to sign in before using the connector at /mcp: Supabase Auth's OAuth server (RFC 9728).
export default function handler(request, response) {
  response.statusCode = 200
  response.setHeader('content-type', 'application/json')
  response.setHeader('cache-control', 'public, max-age=300')
  response.setHeader('access-control-allow-origin', '*')
  response.end(JSON.stringify(resourceMetadata(originOf(request, process.env), process.env)))
}

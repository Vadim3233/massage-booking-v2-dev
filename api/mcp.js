import { handleMcp } from '../server/aiConnector/mcp.js'

// The connector clients add to their own AI assistant, served at /mcp (see server/aiConnector/mcp.js and the /book-with-ai page).
export default function handler(request, response) { return handleMcp(request, response) }

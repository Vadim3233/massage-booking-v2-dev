import { supabase } from '../../lib/supabase.js'
import { unwrap } from './bookingApi.js'

// Two questions a client (or a guest, who has a session of their own) can ask about their own Telegram updates: whether a chat is linked, and
// for a one-time code to link one. Both are answered by the database for the signed-in or guest client; neither can be asked for anyone else.
export function createTelegramApi(client) {
  return {
    status: async () => Boolean((await unwrap(client.rpc('my_telegram_status')))?.linked),
    createLink: () => unwrap(client.rpc('create_my_telegram_link')),
  }
}

export const telegramApi = createTelegramApi(supabase)

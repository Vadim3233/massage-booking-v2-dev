// The gift pages' calls. Anyone may make them (no account needed); the database checks everything.
async function unwrap(request) {
  const { data, error } = await request
  if (error) throw error
  return data
}

export function createGiftApi(client) {
  return {
    options: () => unwrap(client.rpc('get_gift_options')),
    buy: form => unwrap(client.rpc('buy_gift_voucher', {
      p_minutes: form.minutes, p_people: form.people, p_travel_choice: form.travelChoice, p_service_area_id: form.areaId || null,
      p_design: form.design, p_recipient_name: form.to.trim(), p_from_name: form.from.trim(), p_message: form.message.trim() || null,
      p_delivery: form.delivery, p_recipient_email: form.delivery === 'email' ? form.recipientEmail.trim() : null,
      p_send_at: form.delivery === 'email' ? form.sendAt : null,
      p_buyer_name: form.buyerName.trim(), p_buyer_email: form.buyerEmail.trim(), p_buyer_phone: form.buyerPhone.trim() || null,
    })),
    purchase: token => unwrap(client.rpc('get_my_gift_purchase', { p_token: token })),
    transferMade: token => unwrap(client.rpc('gift_transfer_made', { p_token: token })),
    voucher: code => unwrap(client.rpc('get_gift_voucher', { p_code: code })),
  }
}

// The day and time an emailed voucher arrives: 8 in the morning, London time, on the chosen day.
export function sendAtFor(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return null
  const [year, month, date] = day.split('-').map(Number)
  // 08:00 in London is 08:00 UTC in winter and 07:00 UTC in summer.
  const guess = new Date(Date.UTC(year, month - 1, date, 8))
  const londonHour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/London' }).format(guess))
  return new Date(guess.getTime() - (londonHour - 8) * 3600000).toISOString()
}

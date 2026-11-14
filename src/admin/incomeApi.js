import { supabase } from '../lib/supabase.js'

// The Income screen's reads. All of them are Admin-only database functions that do every sum; nothing is added up here.
export function createIncomeApi(client) {
  async function run(request, what) {
    const { data, error } = await request
    if (error) throw new Error(error.code === 'PGRST202' ? 'Income needs a database update first.' : `Could not load ${what}. Please try again.`)
    return data
  }
  return {
    summary: (kind, anchor) => run(client.rpc('admin_income_summary', { p_kind: kind, p_anchor: anchor }), 'the income'),
    rows: (from, to) => run(client.rpc('admin_income_rows', { p_from: from, p_to: to }), 'the bookings'),
    owed: () => run(client.rpc('admin_money_owed'), 'money owed'),
    // Busiest times (20261213100000_busy_times.sql): every visit with its start time and money, and the times people wanted when full.
    busy: () => run(client.rpc('admin_busy_times'), 'busiest times'),
    saveWeekly: on => run(client.rpc('admin_save_weekly_summary', { p_on: on }), 'the setting'),
  }
}
export const incomeApi = createIncomeApi(supabase)

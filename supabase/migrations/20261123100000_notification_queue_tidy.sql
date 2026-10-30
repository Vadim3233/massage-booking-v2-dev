-- VAD Massage Booking V2
-- The notification queue no longer keeps messages stuck or sends very late ones (ADR-088).
--
-- 1. A message whose fifth try never reported back stayed "sending" for ever: never tried again, never shown as failed. It is now marked
--    failed.
-- 2. A message more than two days old is no longer sent. Before, switching a channel back on (Telegram or email set up again) sent every
--    message waiting for it at once, including reminders for appointments already past. It is marked failed with the reason.
-- Otherwise the claim is unchanged.

create or replace function public.claim_notification_deliveries(p_limit integer, p_channels text[])
returns setof public.notification_deliveries
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.notification_deliveries d set status = 'failed', last_error = 'Stopped after 5 tries; the last try did not report back.'
  where d.status = 'sending' and d.attempt_count >= 5 and d.updated_at < clock_timestamp() - interval '10 minutes';

  update public.notification_deliveries d set status = 'failed', attempt_count = greatest(d.attempt_count, 5),
    last_error = 'Not sent: more than two days late.'
  where d.channel = any(p_channels) and d.channel <> 'in_app' and d.attempt_count < 5 and d.status in ('pending', 'failed')
    and d.created_at < clock_timestamp() - interval '2 days';

  return query
  with picked as (
    select d.id from public.notification_deliveries d
    where d.channel = any(p_channels) and d.channel <> 'in_app' and d.attempt_count < 5
      and d.created_at >= clock_timestamp() - interval '2 days'
      and ((d.status in ('pending', 'failed') and d.next_attempt_at <= clock_timestamp())
        or (d.status = 'sending' and d.updated_at < clock_timestamp() - interval '10 minutes'))
    order by d.created_at
    limit least(greatest(coalesce(p_limit, 10), 1), 50)
    for update skip locked
  )
  update public.notification_deliveries d set status = 'sending', attempt_count = d.attempt_count + 1
  from picked where d.id = picked.id
  returning d.*;
end;
$$;
revoke all on function public.claim_notification_deliveries(integer, text[]) from public, anon, authenticated;
grant execute on function public.claim_notification_deliveries(integer, text[]) to service_role;

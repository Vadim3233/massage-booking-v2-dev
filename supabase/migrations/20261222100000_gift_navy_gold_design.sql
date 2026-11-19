-- Gift vouchers: six new design names (Vadim, 19 Nov 2026): "Navy and gold", matching the booking page's "Give the Gift of Wellness" card,
-- and five occasion designs (two birthdays, for him, anniversary, new baby).
-- Only the list of allowed design names changes. Safe to run more than once.
alter table public.gift_vouchers drop constraint if exists gift_vouchers_design_valid;
alter table public.gift_vouchers add constraint gift_vouchers_design_valid
  check (design in ('christmas_night', 'wrapped_present', 'gold_foil', 'black_gold', 'any_occasion', 'navy_gold',
    'birthday_navy', 'birthday_pink', 'for_him', 'anniversary', 'new_baby'));

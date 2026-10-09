-- Online reservation creation requires an authenticated member account linked
-- to an active library record. Card/PIN remains available for account linking
-- and reservation lookup/cancellation, but cannot create new holds.
revoke all on function public.reserve_book_by_card(text, text, uuid)
  from public, anon, authenticated;

revoke all on function public.reserve_book(uuid) from public, anon;
grant execute on function public.reserve_book(uuid) to authenticated;

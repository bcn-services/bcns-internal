-- Reverse of 0006_seed_clients. Clients first: accounts.id is referenced with
-- on delete restrict, so the account cannot go while a client row points at it.
delete from clients where slug in
  ('l2detailz', 'coventry', 'delucas', 'technology-associates', 'wwc');

delete from accounts where business_name in
  ('L2 Detailz', 'Coventry Painting & General Contracting', 'DeLuca''s',
   'Technology Associates', 'Wholesale Window Company');

-- Undo 0011. The badge's count still answers correctly afterwards, from
-- 0009's inbox_items_profile_idx — only slower.
drop index if exists inbox_items_unread_idx;

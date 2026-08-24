-- Reverses 0008_agent_tokens. Dropping the table destroys every enrolled
-- token; each employee must re-run `claude setup-token`. There is no backup
-- worth taking — the ciphertext is useless without AGENT_TOKEN_KEY anyway.
drop table if exists agent_tokens;

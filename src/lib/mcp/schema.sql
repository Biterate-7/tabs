-- Hubble MCP access tokens.
--
-- Credentials a signed-in user mints so an MCP client (Claude Desktop) can
-- read their Hubble context. See src/lib/mcp/tokens.ts.
--
-- Additive and idempotent, like every schema in this project: IF NOT EXISTS
-- throughout, so applying it twice is a no-op and applying it to a populated
-- database touches nothing else. Apply with `npm run migrate:mcp`.
--
-- Depends on tabdump_users (src/lib/auth/store/schema.sql).

CREATE TABLE IF NOT EXISTS tabdump_mcp_tokens (
  id            TEXT PRIMARY KEY,
  -- A deleted account takes its tokens with it.
  user_id       UUID NOT NULL REFERENCES tabdump_users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  -- SHA-256 of the token, never the token. The CHECK makes that structural:
  -- a plaintext `tdmcp_...` value cannot satisfy it.
  token_hash    TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  hint          TEXT NOT NULL CHECK (char_length(hint) = 4),
  -- A closed scope list with one member. Anything else is refused here as
  -- well as in code, so a write-scoped token cannot exist by accident.
  scopes        TEXT[] NOT NULL CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['read']::TEXT[]),
  created_at    BIGINT NOT NULL,
  expires_at    BIGINT NOT NULL CHECK (expires_at > created_at),
  last_used_at  BIGINT,
  revoked_at    BIGINT
);

-- The settings list, and the per-account live-token count.
CREATE INDEX IF NOT EXISTS tabdump_mcp_tokens_user_idx
  ON tabdump_mcp_tokens (user_id, created_at DESC);

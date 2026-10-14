-- Operations: every movement of money, the whole history of a budget (ARCHITECTURE.md §5.5).
-- The balances of pouches are computed from it and kept nowhere else (§5.6). All four kinds
-- are here from the start; M5 writes expenses only.

CREATE TABLE operations (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id integer NOT NULL,
  -- income: into the treasury; assign: treasury → pouch; expense: out of a pouch;
  -- transfer: pouch → another pouch.
  kind text NOT NULL CHECK (kind IN ('income', 'assign', 'expense', 'transfer')),
  -- Hundredths of the currency, always positive: the kind gives the direction.
  amount bigint NOT NULL CHECK (amount BETWEEN 1 AND 100000000000),
  -- The currency of the installation when the record was written (§5.6).
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  from_pouch_id integer,
  to_pouch_id integer,
  -- A calendar date without a time.
  date date NOT NULL,
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  CONSTRAINT operations_pouches_by_kind CHECK (
       (kind = 'income'   AND from_pouch_id IS NULL     AND to_pouch_id IS NULL)
    OR (kind = 'assign'   AND from_pouch_id IS NULL     AND to_pouch_id IS NOT NULL)
    OR (kind = 'expense'  AND from_pouch_id IS NOT NULL AND to_pouch_id IS NULL)
    OR (kind = 'transfer' AND from_pouch_id IS NOT NULL AND to_pouch_id IS NOT NULL
                          AND from_pouch_id <> to_pouch_id)),
  -- A record points only to pouches of its own user: even a mistake in the code cannot write
  -- an expense into somebody else's pouch. An empty pouch column is not checked.
  FOREIGN KEY (from_pouch_id, user_id) REFERENCES pouches (id, user_id),
  FOREIGN KEY (to_pouch_id, user_id) REFERENCES pouches (id, user_id)
);

-- The history of a user by date, and the records of a user for the balances.
CREATE INDEX operations_user_date ON operations (user_id, date, id);

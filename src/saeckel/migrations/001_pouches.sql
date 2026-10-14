-- Pouches: the categories money is laid out into (ARCHITECTURE.md §5.4).
-- user_id is a plain value: the role hof_saeckel cannot see schema core, so there is no foreign
-- key to core.users (§2, §5.1). People are never deleted, only disabled.

CREATE TABLE pouches (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id integer NOT NULL,
  -- The application trims and normalises the name; this is the second line.
  name text NOT NULL
    CONSTRAINT pouches_name_format CHECK (char_length(name) BETWEEN 1 AND 50 AND name = btrim(name)),
  -- A key of the set in the Säckel code. No CHECK: the set grows without a migration.
  icon text NOT NULL DEFAULT 'pouch',
  is_archived boolean NOT NULL DEFAULT false,
  -- The target of the composite foreign keys of operations: a record can only point to a pouch
  -- of the same user.
  CONSTRAINT pouches_id_user UNIQUE (id, user_id)
);

-- Names of the active pouches of one user are unique regardless of case. Pouches in the
-- storeroom (Кладовая) may repeat a name; restoring one then runs into this index.
CREATE UNIQUE INDEX pouches_active_name ON pouches (user_id, lower(name)) WHERE NOT is_archived;

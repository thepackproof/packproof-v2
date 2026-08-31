CREATE INDEX users_display_name_lower_idx
  ON users (lower(display_name))
  WHERE display_name IS NOT NULL;

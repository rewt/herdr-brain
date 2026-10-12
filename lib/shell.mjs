// POSIX single-quoting for one shell word.
export const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";

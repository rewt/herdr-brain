// Durable text is untrusted when it is drawn in a terminal. Remove ANSI/VT
// control sequences and the remaining controls without changing ordinary text.
const ESCAPES = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1b[\]PX^_]|[\x90\x98\x9d-\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|\x1b[ -/]*[0-~]?/g;
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;

export function sanitizeTerminal(text) {
  return String(text ?? '').replace(ESCAPES, '').replace(/\r\n?/g, '\n').replace(CONTROLS, '');
}

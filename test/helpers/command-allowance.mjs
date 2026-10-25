// Legacy caller marker; it no longer grants or enforces an elapsed allowance.
// Explicit native command options retain their own semantics.
export const commandAllowance = Symbol('compound fixture command allowance');

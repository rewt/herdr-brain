export class HarnessLimit extends Error {
  constructor(message) { super(message); this.name = 'HarnessLimit'; }
}

export class ProductBoundary extends Error {
  constructor(message) { super(message); this.name = 'ProductBoundary'; }
}
export class Pending extends Error {}
export const isHarnessBoundary = (text) => /acceptance_harness_limit|sandbox_apply: Operation not permitted|fs sandbox helper failed/.test(text);
export const isProductBoundary = (text) => /acceptance_product_boundary|acceptance_boundary|native-transport boundary:/.test(text);
export function commandFailure(message) {
  if (isProductBoundary(message)) return new ProductBoundary(message);
  return isHarnessBoundary(message) ? new HarnessLimit(message) : new Error(message);
}
export function classifyFailure(error, { cleanup = false } = {}) {
  if (error instanceof ProductBoundary || isProductBoundary(error.message)) return { status: 'FAIL', origin: 'product', detail: error.message };
  if (error instanceof HarnessLimit || cleanup) return { status: 'PENDING', origin: 'harness', detail: error.message };
  return { status: error instanceof Pending ? 'PENDING' : 'FAIL', origin: 'product', detail: error.message };
}

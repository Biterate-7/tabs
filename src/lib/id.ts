// Same counter+timestamp shape as parse.ts's tab-id generator, kept here so
// workspace ids and any regenerated (de-collided) tab ids share one scheme
// instead of inventing a second one.
let counter = 0;

export function createId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

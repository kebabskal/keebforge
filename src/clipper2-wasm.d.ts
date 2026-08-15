/** clipper2-wasm ships its typings at `dist/clipper2z.d.ts` but the ESM build
 * lives at `dist/es/clipper2z.js`, which TypeScript therefore sees untyped.
 * The module's surface is an emscripten factory; `offsetClipper2.ts` narrows
 * the handful of entry points it actually uses. */
declare module 'clipper2-wasm/dist/es/clipper2z.js' {
  const factory: (options?: Record<string, unknown>) => Promise<unknown>
  export default factory
}

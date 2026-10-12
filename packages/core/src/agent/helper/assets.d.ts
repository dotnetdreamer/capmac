// The helper's Objective-C source ships inside the agent bundle as text (esbuild's text loader).
declare module '*.m' {
  const source: string;
  export default source;
}

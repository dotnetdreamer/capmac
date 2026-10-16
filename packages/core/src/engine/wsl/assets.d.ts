/** Embedded native-project export helpers ship as source, including in standalone CLI bundles. */
declare module '*.rb' {
  const source: string;
  export default source;
}

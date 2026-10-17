/** Embedded native-project export helpers ship as source, including in standalone CLI bundles. */
declare module '*.rb' {
  const source: string;
  export default source;
}

/** Scripts and C sources CapMac runs in its WSL distro (Flutter's iPhone builds), shipped as text. */
declare module '*.sh' {
  const source: string;
  export default source;
}
declare module '*.py' {
  const source: string;
  export default source;
}
declare module '*.c' {
  const source: string;
  export default source;
}

/** A project's app icon in the iOS rounded-square shape, or a monogram tile when it has none. */
export function AppIcon({ src, name, seed, size = 40 }: { src?: string | null; name: string; seed?: string; size?: number }) {
  if (src) return <img className="app-icon" src={src} alt="" width={size} height={size} draggable={false} />;
  let hash = 0;
  for (const ch of seed ?? name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  const letter = name.trim().charAt(0).toUpperCase() || '?';
  return (
    <span
      className="app-icon app-icon--monogram"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.46),
        background: `linear-gradient(145deg, oklch(0.72 0.14 ${hue}), oklch(0.52 0.16 ${(hue + 30) % 360}))`,
      }}
    >
      {letter}
    </span>
  );
}

/** capmac Studio's own mark (same drawing as the app icon). */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" aria-hidden="true" className="logo">
      <defs>
        <linearGradient id="logo-tile" x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0" stopColor="#8F82FF" />
          <stop offset="0.55" stopColor="#5B4BF0" />
          <stop offset="1" stopColor="#3B2BC4" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="248" height="248" rx="56" fill="url(#logo-tile)" />
      {size <= 24 ? (
        <>
          <rect x="70" y="28" width="116" height="200" rx="28" fill="none" stroke="#fff" strokeWidth="22" />
          <path d="M106 94v68l56-34z" fill="#fff" stroke="#fff" strokeWidth="14" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <rect x="80" y="36" width="96" height="184" rx="25" fill="#fff" fillOpacity="0.12" stroke="#fff" strokeWidth="13" />
          <rect x="114" y="54" width="28" height="9" rx="4.5" fill="#fff" />
          <path d="M113 99v58l46-29z" fill="#fff" stroke="#fff" strokeWidth="12" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
}

export function LogoMark({ size = 24 }: { size?: number }) {
  return (
    <span className="logo-mark" style={{ width: size, height: size }} aria-label="lamsa">
      <svg viewBox="0 0 24 24" width={size * 0.66} height={size * 0.66} fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" />
        <circle cx="12" cy="12" r="7" opacity="0.7" />
        <circle cx="12" cy="12" r="10.5" opacity="0.35" />
      </svg>
    </span>
  );
}

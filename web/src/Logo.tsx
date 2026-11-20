/** Dittoly's mark: two ditto strokes ("the same again") and the run. Takes the text color. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="9 11 46 46" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={7} strokeLinecap="round">
      <path d="M22 18 16 34M36 18 30 34" />
      <circle cx={44} cy={44} r={6} fill="currentColor" stroke="none" opacity={0.55} />
    </svg>
  );
}

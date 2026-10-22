/** The hand-drawn line under the owner's name: on the home page it draws itself, in the footer it is simply there. */
export function PenStroke({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 300 14" preserveAspectRatio="none" aria-hidden="true">
      <path d="M3 9 C 40 2, 70 13, 110 7 S 180 3, 215 8 S 270 11, 297 5" pathLength={1} />
    </svg>
  );
}

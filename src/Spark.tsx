// Mascotte « spark » du design system : un astérisque à 8 rais (4 traits qui se
// croisent au centre), hérite `currentColor`. Optionnellement en rotation lente
// (`spinning`) pour signaler une réflexion en cours.

export function Spark({ className = "", spinning = false }: { className?: string; spinning?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      aria-hidden="true"
      className={`${className} ${spinning ? "motion-safe:animate-[spin_4.5s_linear_infinite]" : ""}`}
    >
      <line x1="12" y1="2.5" x2="12" y2="21.5" />
      <line x1="2.5" y1="12" x2="21.5" y2="12" />
      <line x1="5.8" y1="5.8" x2="18.2" y2="18.2" />
      <line x1="18.2" y1="5.8" x2="5.8" y2="18.2" />
    </svg>
  );
}

import type { ReactNode } from "react";

// Jeu d'icônes « ligne » dans le style Perch : SVG inline, viewBox 24, trait
// `currentColor` (suit le thème), bouts/joints arrondis. Pas de dépendance.
// Usage : <Save className="h-4 w-4" />.

function Svg({ className = "h-4 w-4", children }: { className?: string; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

type P = { className?: string };

export const Sun = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Svg>
);

export const Moon = (p: P) => (
  <Svg {...p}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </Svg>
);

export const FolderOpen = (p: P) => (
  <Svg {...p}>
    <path d="M4 5h5l2 2.5h7a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
  </Svg>
);

export const FileDown = (p: P) => (
  <Svg {...p}>
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
    <path d="M12 11v6M9.5 14.5 12 17l2.5-2.5" />
  </Svg>
);

export const Save = (p: P) => (
  <Svg {...p}>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <path d="M17 21v-8H7v8M7 3v5h8" />
  </Svg>
);

export const Undo = (p: P) => (
  <Svg {...p}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h11a5 5 0 0 1 5 5 5 5 0 0 1-5 5H9" />
  </Svg>
);

export const Redo = (p: P) => (
  <Svg {...p}>
    <path d="m15 14 5-5-5-5" />
    <path d="M20 9H9a5 5 0 0 0-5 5 5 5 0 0 0 5 5h6" />
  </Svg>
);

export const Download = (p: P) => (
  <Svg {...p}>
    <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
  </Svg>
);

export const Search = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </Svg>
);

export const Link = (p: P) => (
  <Svg {...p}>
    <path d="M9 15 15 9" />
    <path d="M11 6l1-1a4 4 0 0 1 5.7 5.7l-2 2" />
    <path d="M13 18l-1 1a4 4 0 0 1-5.7-5.7l2-2" />
  </Svg>
);

export const TableIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="1.5" />
    <path d="M3 10h18M3 15h18M9 4v16M15 4v16" />
  </Svg>
);

export const Target = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
  </Svg>
);

export const Paperclip = (p: P) => (
  <Svg {...p}>
    <path d="M20 11.5 11.7 19.8a4.5 4.5 0 0 1-6.4-6.4l8.6-8.6a3 3 0 0 1 4.3 4.3l-8.5 8.5a1.5 1.5 0 0 1-2.1-2.1l7.7-7.7" />
  </Svg>
);

export const Send = (p: P) => (
  <Svg {...p}>
    <path d="M22 2 11 13" />
    <path d="M22 2 15 22l-4-9-9-4 20-7z" />
  </Svg>
);

export const RefreshCw = (p: P) => (
  <Svg {...p}>
    <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
    <path d="M21 3v5h-5" />
  </Svg>
);

export const X = (p: P) => (
  <Svg {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
);

export const Trash = (p: P) => (
  <Svg {...p}>
    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </Svg>
);

export const Plus = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const Minus = (p: P) => (
  <Svg {...p}>
    <path d="M5 12h14" />
  </Svg>
);

export const ChevronDown = (p: P) => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);

export const Image = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-5-5L5 21" />
  </Svg>
);

export const Pencil = (p: P) => (
  <Svg {...p}>
    <path d="M12 20h9" />
    <path d="m16.5 3.5 4 4L7 21l-4 1 1-4z" />
  </Svg>
);

export const Replace = (p: P) => (
  <Svg {...p}>
    <path d="M14 4h6v6M20 4l-7 7" />
    <path d="M10 20H4v-6M4 20l7-7" />
  </Svg>
);

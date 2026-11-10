const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const Logo = () => (
  <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
    <circle cx="13" cy="13" r="12" fill="none" stroke="var(--accent)" strokeWidth="2" />
    <circle cx="13" cy="13" r="3.5" fill="var(--accent)" />
  </svg>
);

export const Gear = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);

export const FileIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <path d="M14 3v6h6" />
  </svg>
);

export const DownloadIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} strokeWidth={2} aria-hidden="true">
    <path d="M12 4v12" /><path d="m6 11 6 6 6-6" /><path d="M5 20h14" />
  </svg>
);

export const CloseIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} strokeWidth={2} aria-hidden="true">
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const CheckCircle = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" {...stroke} stroke="var(--accent)" strokeWidth={2.2} aria-hidden="true">
    <circle cx="12" cy="12" r="10" /><path d="m8 12.5 2.6 2.6L16 9.7" />
  </svg>
);

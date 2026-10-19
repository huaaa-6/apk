const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
  library: '<path d="M4 4h5v16H4z"/><path d="M9 4h5v16H9z"/><path d="m14 5 4.6-1 3.2 15.4-4.7 1z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  bookmark: '<path d="M6 3h12v18l-6-4.2L6 21z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.6 2.5 4 5.6 4 9s-1.4 6.5-4 9c-2.6-2.5-4-5.6-4-9s1.4-6.5 4-9Z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5S20 17 20 21"/>',
  'arrow-left': '<path d="M19 12H5"/><path d="m11 18-6-6 6-6"/>',
  'arrow-right': '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  'arrow-up': '<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/>',
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  play: '<path d="M8 5.5v13l10-6.5z"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  check: '<path d="m4 12.5 5 5L20 6.5"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="m6 7 1 14h10l1-14"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  refresh: '<path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M6.1 8a7 7 0 0 1 11.6-1.6L20 9"/><path d="M17.9 16A7 7 0 0 1 6.3 17.6L4 15"/>',
  x: '<path d="m6 6 12 12"/><path d="M18 6 6 18"/>',
  menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>',
  eye: '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.6"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r=".8" fill="currentColor"/><circle cx="4.5" cy="12" r=".8" fill="currentColor"/><circle cx="4.5" cy="18" r=".8" fill="currentColor"/>',
  maximize: '<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>',
  minimize: '<path d="M3 8h5V3M21 8h-5V3M3 16h5v5M21 16h-5v5"/>',
  type: '<path d="M4 6V4h16v2"/><path d="M12 4v16"/><path d="M9 20h6"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h10M18 18h2"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
  'log-out': '<path d="M10 4H5v16h5"/><path d="M14 8l4 4-4 4"/><path d="M8 12h10"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="1"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  spark: '<path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M18.5 16.5 19 18l1.5.5L19 19l-.5 1.5L18 19l-1.5-.5L18 18z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.5v.5"/>',
  alert: '<path d="M12 3 2.8 20h18.4z"/><path d="M12 9v5"/><path d="M12 17v.5"/>',
  wifi: '<path d="M2.5 8.5a15 15 0 0 1 19 0"/><path d="M5.5 12a10.5 10.5 0 0 1 13 0"/><path d="M8.5 15.5a6 6 0 0 1 7 0"/><circle cx="12" cy="19" r="1" fill="currentColor"/>',
  'wifi-off': '<path d="m3 3 18 18"/><path d="M8.5 15.5a6 6 0 0 1 7 0"/><path d="M2.5 8.5A15 15 0 0 1 7 6"/><path d="M14.5 6.2a15 15 0 0 1 7 2.3"/><path d="M5.5 12a10.5 10.5 0 0 1 4-2.1"/><path d="M14 9.6a10.5 10.5 0 0 1 4.5 2.4"/><circle cx="12" cy="19" r="1" fill="currentColor"/>',
  'book-open': '<path d="M12 6c-2-2-5-2.5-8-2v14c3-.5 6 0 8 2 2-2 5-2.5 8-2V4c-3-.5-6 0-8 2Z"/><path d="M12 6v14"/>',
  feather: '<path d="M20 4c-3 0-7 2-9 4l-4 4-3 1-1 3 4-1 2.5 2.5L8 20l3-1 1-3 4-4c2-2 4-6 4-8Z"/><path d="M4 20 14 10"/>',
  quote: '<path d="M9 7c-3 0-5 2-5 5v5h5v-5H6c0-2 1-3 3-3Z"/><path d="M18 7c-3 0-5 2-5 5v5h5v-5h-3c0-2 1-3 3-3Z"/>',
  edit: '<path d="M4 20h4l11-11-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 13v6H5V6h6"/>',
  send: '<path d="m3 11 18-8-8 18-2-8z"/><path d="M13 13 21 3"/>'
};

export function icon(name, size = 18, className = '') {
  const body = ICONS[name] || ICONS.info;
  return `<svg class="icon ${className}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function logoMark(size = 34) {
  return `<span class="logo-mark" style="--mark-size:${size}px" aria-hidden="true">
    <svg viewBox="0 0 40 40" fill="none">
      <rect x="5.5" y="5.5" width="29" height="29" rx="3" stroke="currentColor" stroke-width="1.4"/>
      <rect x="9" y="9" width="22" height="22" rx="1.5" stroke="currentColor" stroke-width=".7" opacity=".55"/>
      <path d="M15 12h10M20 12v16M13 28h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/>
      <circle cx="25.5" cy="15" r="1.6" fill="currentColor"/>
    </svg>
  </span>`;
}

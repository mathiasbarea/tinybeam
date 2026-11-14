// The Tinybeam mark: a pixel sending out a beam. Same drawing as docs/brand/*.svg.

const beam = id => `<defs><linearGradient id="${id}" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#F5A524"/><stop offset="1" stop-color="#F5A524" stop-opacity="0"/></linearGradient></defs><rect x="22" y="29" width="40" height="6" fill="url(#${id})"/>`;

// Inline in the header: the pixel takes the text color, so it follows the light or dark theme.
export const MARK = `<svg viewBox="0 0 64 64" width="22" height="22" aria-hidden="true" focusable="false">${beam('tb-beam')}<rect x="6" y="24" width="16" height="16" rx="2" fill="currentColor"/></svg>`;

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><style>.px{fill:#16181d}@media (prefers-color-scheme:dark){.px{fill:#f4f3ef}}</style>${beam('b')}<rect class="px" x="6" y="24" width="16" height="16" rx="2"/></svg>`;
export const FAVICON = `data:image/svg+xml,${encodeURIComponent(favicon)}`;

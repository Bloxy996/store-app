

// ---------------------------------------------------------------------------
// Icon library — small hand-drawn line icons in the same monoline style
// Obsidian itself uses, so nothing in the UI relies on emoji glyphs. Folders
// are identified purely by their expand/collapse chevron, notes have no
// icon at all, and images are identified by their visible ".png"/".jpg"
// extension — exactly per the "no emoji, no redundant icons" brief.
// ---------------------------------------------------------------------------
function Svg({ children, size = 16, style, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, ...style }}
      {...rest}
    >
      {children}
    </svg>
  );
}


const IconChevronRight = (p) => (
  <Svg {...p}>
    <polyline points="9 18 15 12 9 6" />
  </Svg>
);

const IconChevronDown = (p) => (
  <Svg {...p}>
    <polyline points="6 9 12 15 18 9" />
  </Svg>
);

const IconMenu = (p) => (
  <Svg {...p}>
    <line x1="4" y1="7" x2="20" y2="7" />
    <line x1="4" y1="12" x2="20" y2="12" />
    <line x1="4" y1="17" x2="20" y2="17" />
  </Svg>
);

const IconListTree = (p) => (
  <Svg {...p}>
    <line x1="9" y1="6" x2="20" y2="6" />
    <line x1="12" y1="12" x2="20" y2="12" />
    <line x1="12" y1="18" x2="20" y2="18" />
    <circle cx="5" cy="6" r="1.5" />
    <line x1="5" y1="7.5" x2="5" y2="10.5" />
    <line x1="5" y1="10.5" x2="8" y2="12" />
    <line x1="5" y1="10.5" x2="5" y2="16.5" />
    <line x1="5" y1="16.5" x2="8" y2="18" />
  </Svg>
);

const IconPalette = (p) => (
  <Svg {...p}>
    <path d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.4-.3-.4-.5-.9-.5-1.4 0-1.1.9-2 2-2h1.5c1.9 0 3.5-1.6 3.5-3.5C20 6.6 16.4 3 12 3z" />
    <circle cx="7.5" cy="10.5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="11" cy="7" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
  </Svg>
);

const IconPlus = (p) => (
  <Svg {...p}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </Svg>
);

const IconGraph = (p) => (
  <Svg {...p}>
    <line x1="7" y1="7.2" x2="10.2" y2="10.6" />
    <line x1="16.8" y1="7.2" x2="13.6" y2="10.6" />
    <line x1="10.8" y1="13.8" x2="7.4" y2="17.4" />
    <line x1="13.4" y1="13.8" x2="16.6" y2="16.8" />
    <circle cx="5" cy="6" r="2.2" />
    <circle cx="19" cy="6" r="2.2" />
    <circle cx="12" cy="12" r="2.2" />
    <circle cx="6" cy="19" r="2.2" />
    <circle cx="18" cy="18" r="2.2" />
  </Svg>
);

const IconMaximize = (p) => (
  <Svg {...p}>
    <polyline points="8 3 3 3 3 8" />
    <polyline points="16 3 21 3 21 8" />
    <polyline points="3 16 3 21 8 21" />
    <polyline points="21 16 21 21 16 21" />
  </Svg>
);

const IconFilePlus = (p) => (
  <Svg {...p}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="12" y1="12" x2="12" y2="18" />
    <line x1="9" y1="15" x2="15" y2="15" />
  </Svg>
);

const IconFolderPlus = (p) => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <line x1="12" y1="11" x2="12" y2="16" />
    <line x1="9.5" y1="13.5" x2="14.5" y2="13.5" />
  </Svg>
);

const IconUpload = (p) => (
  <Svg {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </Svg>
);

const IconMoreVertical = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none" />
  </Svg>
);

const IconEdit = (p) => (
  <Svg {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </Svg>
);

const IconTrash = (p) => (
  <Svg {...p}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
  </Svg>
);

const IconX = (p) => (
  <Svg {...p}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </Svg>
);

const IconPanelLeft = (p) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <line x1="9" y1="4" x2="9" y2="20" />
  </Svg>
);

const IconSearch = (p) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.2" y2="16.2" />
  </Svg>
);

const IconTag = (p) => (
  <Svg {...p}>
    <path d="M20.6 12.6 12.4 20.8a2 2 0 0 1-2.8 0l-7.4-7.4a2 2 0 0 1 0-2.8L10.4 2.4A2 2 0 0 1 11.8 2H18a2 2 0 0 1 2 2v6.2a2 2 0 0 1-.6 1.4Z" />
    <circle cx="15" cy="8" r="1.4" fill="currentColor" stroke="none" />
  </Svg>
);

const IconStar = (p) => (
  <Svg {...p}>
    <polygon points="12 2 15.1 8.6 22 9.6 17 14.6 18.2 21.6 12 18.2 5.8 21.6 7 14.6 2 9.6 8.9 8.6" />
  </Svg>
);

const IconStarFilled = (p) => (
  <Svg {...p} fill="currentColor">
    <polygon points="12 2 15.1 8.6 22 9.6 17 14.6 18.2 21.6 12 18.2 5.8 21.6 7 14.6 2 9.6 8.9 8.6" />
  </Svg>
);

const IconRefresh = (p) => (
  <Svg {...p}>
    <polyline points="23 4 23 10 17 10" />
    <polyline points="1 20 1 14 7 14" />
    <path d="M3.5 9a8.5 8.5 0 0 1 14.3-4.1L23 10" />
    <path d="M20.5 15a8.5 8.5 0 0 1-14.3 4.1L1 14" />
  </Svg>
);

const IconLogOut = (p) => (
  <Svg {...p}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </Svg>
);

const IconFolder = (p) => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
);

const IconDrive = (p) => (
  <Svg {...p}>
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <line x1="6" y1="15" x2="6.01" y2="15" />
  </Svg>
);

const IconSplitVertical = (p) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <line x1="12" y1="4" x2="12" y2="20" />
  </Svg>
);

const IconSplitHorizontal = (p) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <line x1="3" y1="12" x2="21" y2="12" />
  </Svg>
);

const IconEye = (p) => (
  <Svg {...p}>
    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);

const IconArrowLeft = (p) => (
  <Svg {...p}>
    <line x1="19" y1="12" x2="5" y2="12" />
    <polyline points="12 19 5 12 12 5" />
  </Svg>
);

const IconArrowRight = (p) => (
  <Svg {...p}>
    <line x1="5" y1="12" x2="19" y2="12" />
    <polyline points="12 5 19 12 12 19" />
  </Svg>
);

const IconSettings = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
  </Svg>
);

const IconHelp = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M9.1 9a3 3 0 0 1 5.82 1c0 2-3 2.5-3 4.5" />
    <line x1="12" y1="17.5" x2="12" y2="17.51" />
  </Svg>
);

const IconSliders = (p) => (
  <Svg {...p}>
    <line x1="4" y1="6" x2="20" y2="6" />
    <line x1="4" y1="12" x2="20" y2="12" />
    <line x1="4" y1="18" x2="20" y2="18" />
    <circle cx="9" cy="6" r="2" fill="var(--bg-1)" />
    <circle cx="15" cy="12" r="2" fill="var(--bg-1)" />
    <circle cx="7" cy="18" r="2" fill="var(--bg-1)" />
  </Svg>
);

const IconInfo = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="16" x2="12" y2="11.5" />
    <line x1="12" y1="8" x2="12" y2="8.01" />
  </Svg>
);

const IconImageMissing = (p) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="1.8" />
    <path d="m21 15-5-5L5 21" />
    <line x1="3" y1="3" x2="21" y2="21" stroke="var(--danger)" />
  </Svg>
);

const IconCheck = (p) => (
  <Svg {...p}>
    <polyline points="20 6 9 17 4 12" />
  </Svg>
);

const IconVideo = (p) => (
  <Svg {...p}>
    <rect x="2" y="5" width="14" height="14" rx="2" />
    <path d="m16 9 6-3v12l-6-3" />
  </Svg>
);

const IconAudio = (p) => (
  <Svg {...p}>
    <path d="M9 18V5l12-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="16" r="3" />
  </Svg>
);

const IconFile = (p) => (
  <Svg {...p}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </Svg>
);

const IconDownload = (p) => (
  <Svg {...p}>
    <path d="M12 3v12" />
    <polyline points="7 11 12 16 17 11" />
    <path d="M5 20h14" />
  </Svg>
);

const IconDatabase = (p) => (
  <Svg {...p}>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
    <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
  </Svg>
);

const IconTable = (p) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <line x1="3" y1="10" x2="21" y2="10" />
    <line x1="9" y1="4" x2="9" y2="20" />
  </Svg>
);

const IconKanban = (p) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <line x1="9" y1="4" x2="9" y2="20" />
    <line x1="15" y1="4" x2="15" y2="20" />
    <line x1="5.5" y1="8" x2="6.5" y2="8" />
    <line x1="11.5" y1="8" x2="12.5" y2="8" />
    <line x1="17.5" y1="8" x2="18.5" y2="8" />
  </Svg>
);

const IconLayoutGrid = (p) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1.3" />
    <rect x="14" y="3" width="7" height="7" rx="1.3" />
    <rect x="3" y="14" width="7" height="7" rx="1.3" />
    <rect x="14" y="14" width="7" height="7" rx="1.3" />
  </Svg>
);

const IconCalendar = (p) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="16" rx="2" />
    <line x1="3" y1="9.5" x2="21" y2="9.5" />
    <line x1="8" y1="2.5" x2="8" y2="6.5" />
    <line x1="16" y1="2.5" x2="16" y2="6.5" />
  </Svg>
);

const IconHash = (p) => (
  <Svg {...p}>
    <line x1="5" y1="9" x2="19" y2="9" />
    <line x1="5" y1="15" x2="19" y2="15" />
    <line x1="9.5" y1="4" x2="7" y2="20" />
    <line x1="16" y1="4" x2="13.5" y2="20" />
  </Svg>
);

const IconType = (p) => (
  <Svg {...p}>
    <polyline points="4 6 4 4 20 4 20 6" />
    <line x1="12" y1="4" x2="12" y2="20" />
    <line x1="9" y1="20" x2="15" y2="20" />
  </Svg>
);

const IconAlignLeft = (p) => (
  <Svg {...p}>
    <line x1="4" y1="6" x2="20" y2="6" />
    <line x1="4" y1="12" x2="15" y2="12" />
    <line x1="4" y1="18" x2="18" y2="18" />
  </Svg>
);

const IconCheckSquare = (p) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <polyline points="7.5 12 10.5 15 16.5 9" />
  </Svg>
);

const IconChevronsUpDown = (p) => (
  <Svg {...p}>
    <polyline points="7 15 12 20 17 15" />
    <polyline points="7 9 12 4 17 9" />
  </Svg>
);

const IconGripVertical = (p) => (
  <Svg {...p} fill="currentColor" stroke="none">
    <circle cx="9" cy="5" r="1.4" />
    <circle cx="9" cy="12" r="1.4" />
    <circle cx="9" cy="19" r="1.4" />
    <circle cx="15" cy="5" r="1.4" />
    <circle cx="15" cy="12" r="1.4" />
    <circle cx="15" cy="19" r="1.4" />
  </Svg>
);

const IconPaperclip = (p) => (
  <Svg {...p}>
    <path d="M21 12.5 12.5 21a5 5 0 0 1-7-7L14 5.5a3.5 3.5 0 0 1 5 5L10.5 19a2 2 0 0 1-3-3L15 8.5" />
  </Svg>
);

const IconLink2 = (p) => (
  <Svg {...p}>
    <path d="M9 17H7A5 5 0 0 1 7 7h2" />
    <path d="M15 7h2a5 5 0 1 1 0 10h-2" />
    <line x1="8" y1="12" x2="16" y2="12" />
  </Svg>
);

const IconTags = (p) => (
  <Svg {...p}>
    <path d="M17.6 12.6 9.4 20.8a2 2 0 0 1-2.8 0l-4.4-4.4a2 2 0 0 1 0-2.8L10.4 5.4A2 2 0 0 1 11.8 5H18a2 2 0 0 1 2 2v6.2a2 2 0 0 1-.4 1.4Z" />
    <circle cx="14.5" cy="9.5" r="1.2" fill="currentColor" stroke="none" />
  </Svg>
);

// Small kind -> icon lookup for non-note tree rows. Images get no override
// (they already read clearly from the filename/thumbnail elsewhere), so
// only video/audio/generic-file/database/canvas get a distinguishing glyph
// in the sidebar. Defined after the icon consts below it (ASSET_KIND_ICONS
// references IconCanvasKind, so it must come after that const is declared).
const IconLoader = (p) => (
  <Svg {...p} className={`spin ${p.className || ''}`}>
    <line x1="12" y1="2" x2="12" y2="6" />
    <line x1="12" y1="18" x2="12" y2="22" />
    <line x1="4.9" y1="4.9" x2="7.8" y2="7.8" />
    <line x1="16.2" y1="16.2" x2="19.1" y2="19.1" />
    <line x1="2" y1="12" x2="6" y2="12" />
    <line x1="18" y1="12" x2="22" y2="12" />
    <line x1="4.9" y1="19.1" x2="7.8" y2="16.2" />
    <line x1="16.2" y1="7.8" x2="19.1" y2="4.9" />
  </Svg>
);

const IconCommand = (p) => (
  <Svg {...p}>
    <path d="M6 3a3 3 0 0 1 3 3v12a3 3 0 1 1-3-3h12a3 3 0 1 1-3 3V6a3 3 0 1 1 3-3H6z" />
  </Svg>
);

const IconAlertTriangle = (p) => (
  <Svg {...p}>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12" y2="17.01" />
  </Svg>
);

// Canvas icons — used for the sidebar/kind icon, the toolbar, and the
// per-node context menu. Kept near the rest of the icon set.
const IconCanvasKind = (p) => (
  <Svg {...p}>
    <rect x="3" y="4" width="8" height="6" rx="1" />
    <rect x="13" y="3" width="8" height="5" rx="1" />
    <rect x="13" y="12" width="8" height="9" rx="1" />
    <rect x="3" y="14" width="8" height="7" rx="1" />
    <line x1="11" y1="7" x2="13" y2="6" />
    <line x1="17" y1="8" x2="17" y2="12" />
    <line x1="11" y1="17" x2="13" y2="17" />
  </Svg>
);

const IconZoomIn = (p) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <line x1="10.5" y1="7.5" x2="10.5" y2="13.5" />
    <line x1="7.5" y1="10.5" x2="13.5" y2="10.5" />
    <line x1="20" y1="20" x2="15.5" y2="15.5" />
  </Svg>
);

const IconZoomOut = (p) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <line x1="7.5" y1="10.5" x2="13.5" y2="10.5" />
    <line x1="20" y1="20" x2="15.5" y2="15.5" />
  </Svg>
);

const IconFrame = (p) => (
  <Svg {...p}>
    <line x1="4" y1="2" x2="4" y2="22" />
    <line x1="20" y1="2" x2="20" y2="22" />
    <line x1="2" y1="4" x2="22" y2="4" />
    <line x1="2" y1="20" x2="22" y2="20" />
  </Svg>
);

const IconStickyNote = (p) => (
  <Svg {...p}>
    <path d="M4 4h13l3 3v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
    <path d="M16 4v4h4" />
  </Svg>
);


const IconImage = (p) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="m21 15-5-5L5 21" />
  </Svg>
);

const IconExpand = (p) => (
  <Svg {...p}>
    <polyline points="15 3 21 3 21 9" />
    <polyline points="9 21 3 21 3 15" />
    <line x1="21" y1="3" x2="14" y2="10" />
    <line x1="3" y1="21" x2="10" y2="14" />
  </Svg>
);

const ASSET_KIND_ICONS = { video: IconVideo, audio: IconAudio, file: IconFile, database: IconDatabase, canvas: IconCanvasKind };

export { Svg, IconChevronRight, IconChevronDown, IconMenu, IconListTree, IconPalette, IconPlus, IconGraph, IconMaximize, IconFilePlus, IconFolderPlus, IconUpload, IconMoreVertical, IconEdit, IconTrash, IconX, IconPanelLeft, IconSearch, IconTag, IconStar, IconStarFilled, IconRefresh, IconLogOut, IconFolder, IconDrive, IconSplitVertical, IconSplitHorizontal, IconEye, IconArrowLeft, IconArrowRight, IconSettings, IconHelp, IconSliders, IconInfo, IconImageMissing, IconCheck, IconVideo, IconAudio, IconFile, IconDownload, IconDatabase, IconTable, IconKanban, IconLayoutGrid, IconCalendar, IconHash, IconType, IconAlignLeft, IconCheckSquare, IconChevronsUpDown, IconGripVertical, IconPaperclip, IconLink2, IconTags, IconLoader, IconCommand, IconAlertTriangle, IconCanvasKind, IconZoomIn, IconZoomOut, IconFrame, IconStickyNote, IconImage, IconExpand, ASSET_KIND_ICONS };

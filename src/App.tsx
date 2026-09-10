import React, { useRef, useState, useEffect, ChangeEvent, FormEvent } from "react";

/* ============================================================
   Built-in starting album (no cloud — bake your photos into
   the file you send someone)
   ============================================================
   Workflow:
   1. Open this app yourself and build out your crews, events,
      and photos as normal.
   2. Click the "⬇ Export Album" button in the app — it downloads
      a JSON file with everything in it.
   3. Open that JSON file, copy its ENTIRE contents, and paste it
      in place of `null` below (so it reads
      `const BUILT_IN_ALBUM_DATA: Group[] | null = [ ...your data... ];`).
   4. Save this file and send/deploy it. Anyone who opens it in a
      fresh browser (no prior data saved) will see your album
      already loaded — nothing uploaded anywhere, it's just part
      of the code itself.

   Once someone opens the link, their own edits are saved only in
   THEIR browser (via localStorage) and won't sync back to you —
   this is the no-cloud, no-server tradeoff.
   ============================================================ */
const BUILT_IN_ALBUM_DATA: Group[] | null = null;

/* ============================================================
   Access control
   ============================================================
   Set your own password below. Anyone who wants to open this
   album must know this exact value — it lives only in this
   file, so only you (the developer) control it.
   ============================================================ */
const ACCESS_PASSWORD = "FIONA_911";

// Key used to remember an unlocked session in this browser tab only.
const AUTH_SESSION_KEY = "special-moments-unlocked";

// IndexedDB is used (instead of localStorage) to persist the actual album
// data — crews, events, and photos — because its storage quota is vastly
// larger (typically hundreds of MB to a few GB, vs. localStorage's ~5MB).
// This matters a lot here since photos are stored as base64 text.
const ALBUM_DB_NAME = "special-moments-db";
const ALBUM_DB_VERSION = 1;
const ALBUM_STORE_NAME = "album";
const ALBUM_RECORD_KEY = "current";

// Old key from an earlier version of this app that used localStorage.
// Kept only so existing users' data gets migrated into IndexedDB once.
const LEGACY_ALBUM_STORAGE_KEY = "special-moments-album-data";

/* ============================================================
   Types
   ============================================================ */

interface Photo {
  id: string;
  url: string | null;
}

interface EventFolder {
  id: string;
  title: string;
  date: string; // ISO yyyy-mm-dd
  photos: Photo[];
}

interface Group {
  id: string;
  name: string;
  cover: string;
  events: EventFolder[];
}

type DialogState =
  | { type: "none" }
  | { type: "newGroup" }
  | { type: "editGroup"; groupId: string }
  | { type: "confirmDeleteGroup"; groupId: string; name: string }
  | { type: "newEvent"; groupId: string }
  | { type: "editEvent"; groupId: string; eventId: string }
  | { type: "confirmDeleteEvent"; groupId: string; eventId: string; title: string };

/* ============================================================
   Helpers & mock starter data
   ============================================================ */

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function makeEmptyPhotos(count: number): Photo[] {
  return Array.from({ length: count }, () => ({ id: uid(), url: null }));
}

function createDefaultGroups(): Group[] {
  return [
    {
      id: uid(),
      name: "High School Friends",
      cover: "https://picsum.photos/seed/hs-crew/500/350",
      events: [
        {
          id: uid(),
          title: "Graduation Day",
          date: "2026-06-12",
          photos: [
            { id: uid(), url: "https://picsum.photos/seed/grad-one/400/400" },
            { id: uid(), url: "https://picsum.photos/seed/grad-two/400/400" },
            ...makeEmptyPhotos(3),
          ],
        },
        {
          id: uid(),
          title: "Prom Night",
          date: "2026-04-18",
          photos: makeEmptyPhotos(5),
        },
      ],
    },
    {
      id: uid(),
      name: "Family",
      cover: "https://picsum.photos/seed/family-crew/500/350",
      events: [
        {
          id: uid(),
          title: "Beach Vacation",
          date: "2026-07-04",
          photos: [
            { id: uid(), url: "https://picsum.photos/seed/beach-one/400/400" },
            ...makeEmptyPhotos(4),
          ],
        },
      ],
    },
    {
      id: uid(),
      name: "College Friends",
      cover: "https://picsum.photos/seed/college-crew/500/350",
      events: [],
    },
  ];
}

function openAlbumDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this environment."));
      return;
    }
    const request = indexedDB.open(ALBUM_DB_NAME, ALBUM_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ALBUM_STORE_NAME)) {
        db.createObjectStore(ALBUM_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadGroupsFromDb(): Promise<Group[] | null> {
  try {
    const db = await openAlbumDb();
    return await new Promise<Group[] | null>((resolve, reject) => {
      const tx = db.transaction(ALBUM_STORE_NAME, "readonly");
      const req = tx.objectStore(ALBUM_STORE_NAME).get(ALBUM_RECORD_KEY);
      req.onsuccess = () => {
        const result = req.result;
        resolve(Array.isArray(result) ? (result as Group[]) : null);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function saveGroupsToDb(groups: Group[]): Promise<void> {
  const db = await openAlbumDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(ALBUM_STORE_NAME, "readwrite");
    tx.objectStore(ALBUM_STORE_NAME).put(groups, ALBUM_RECORD_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// One-time migration: if an older version of this app left data behind in
// localStorage, pull it into IndexedDB so nobody loses their album.
function loadLegacyGroupsFromLocalStorage(): Group[] | null {
  try {
    const raw = localStorage.getItem(LEGACY_ALBUM_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as Group[]) : null;
  } catch {
    return null;
  }
}

function formatBadgeDate(date: Date): string {
  return `⚓ ${date.toLocaleDateString("en-US", { month: "long", day: "numeric" })}`;
}

function formatEventDate(dateStr: string): string {
  if (!dateStr) return "";
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/* ============================================================
   Styles
   ============================================================ */

const styles = `
@import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600;700&family=Nunito:wght@400;600;700;800&display=swap');

.app {
  --navy: #0c1a2e;
  --navy-deep: #081222;
  --parchment: #fdf0d0;
  --sand: #c9a96e;
  --gold: #c8960a;
  --gold-light: #f0a832;
  --ocean: #1a4a6b;
  --ink: #3b2f1c;

  position: relative;
  min-height: 100vh;
  overflow-x: hidden;
  background:
    radial-gradient(ellipse at top, rgba(26,74,107,0.55), transparent 60%),
    linear-gradient(180deg, var(--navy) 0%, var(--navy-deep) 100%);
  font-family: 'Nunito', sans-serif;
  color: var(--parchment);
}

.app *, .app *::before, .app *::after { box-sizing: border-box; }

.app::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background-image: repeating-linear-gradient(
    0deg,
    rgba(255,255,255,0.015) 0px,
    rgba(255,255,255,0.015) 1px,
    transparent 1px,
    transparent 3px
  );
}

/* ---------- Hero ---------- */
.hero {
  position: relative;
  z-index: 1;
  text-align: center;
  padding: 64px 24px 48px;
}

.flag {
  display: inline-block;
  font-size: 56px;
  transform-origin: bottom left;
  animation: sway 3.2s ease-in-out infinite;
  filter: drop-shadow(0 6px 10px rgba(0,0,0,0.5));
}

@keyframes sway {
  0%, 100% { transform: rotate(-6deg); }
  50% { transform: rotate(8deg); }
}

.date-pill {
  display: inline-block;
  margin: 18px auto 0;
  padding: 6px 18px;
  border-radius: 999px;
  background: rgba(200,150,10,0.15);
  border: 1px solid var(--gold);
  color: var(--gold-light);
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.04em;
}

.hero-title {
  font-family: 'Cinzel', serif;
  font-size: clamp(32px, 5vw, 54px);
  margin: 20px 0 12px;
  color: var(--parchment);
  text-shadow: 0 2px 18px rgba(240,168,50,0.25);
}

.hero-subtitle {
  max-width: 520px;
  margin: 0 auto;
  color: rgba(253,240,208,0.75);
  font-size: 16px;
  line-height: 1.6;
}

.compass {
  position: absolute;
  top: 36px;
  right: 6%;
  font-size: 40px;
  opacity: 0.5;
  animation: spin 18s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* ---------- Content ---------- */
.content {
  position: relative;
  z-index: 1;
  max-width: 1080px;
  margin: 0 auto;
  padding: 0 24px 80px;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 24px;
}

.section-header-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.import-success {
  margin-bottom: 18px;
  padding: 10px 16px;
  border-radius: 10px;
  border: 1px solid rgba(46,139,87,0.5);
  background: rgba(46,139,87,0.15);
  color: #8fe0b3;
  font-size: 13px;
  font-weight: 700;
}

.storage-warning {
  margin-bottom: 18px;
  padding: 10px 16px;
  border-radius: 10px;
  border: 1px solid rgba(240,168,50,0.5);
  background: rgba(200,150,10,0.12);
  color: var(--gold-light);
  font-size: 13px;
  font-weight: 700;
}

.section-header h2 {
  font-family: 'Cinzel', serif;
  font-size: 24px;
  color: var(--gold-light);
  margin: 0;
}

.btn {
  font-family: 'Nunito', sans-serif;
  font-weight: 700;
  font-size: 14px;
  border: none;
  border-radius: 10px;
  padding: 10px 20px;
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
}

.btn-gold {
  background: linear-gradient(135deg, var(--gold-light), var(--gold));
  color: #2a1c02;
  box-shadow: 0 4px 14px rgba(200,150,10,0.35);
}
.btn-gold:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(200,150,10,0.45); }
.btn-gold:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }

.btn-ghost {
  background: transparent;
  color: var(--parchment);
  border: 1px solid rgba(253,240,208,0.3);
}
.btn-ghost:hover { background: rgba(253,240,208,0.08); }

.btn-danger { background: #7a2222; color: #ffe9e9; }
.btn-danger:hover { background: #922828; }

/* ---------- Group / Crew cards ---------- */
.groups-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 24px;
}

.group-card {
  position: relative;
  height: 190px;
  padding: 0;
  border-radius: 14px;
  overflow: hidden;
  border: 2px solid var(--sand);
  background: var(--parchment);
  cursor: pointer;
  transition: transform 0.25s ease, box-shadow 0.25s ease, border-color 0.25s ease;
}

.group-card:hover {
  transform: translateY(-6px) rotate(-1deg);
  border-color: var(--gold-light);
  box-shadow: 0 14px 34px rgba(0,0,0,0.45), 0 0 0 3px rgba(240,168,50,0.25);
}

.group-card:focus-visible {
  outline: 2px solid var(--gold-light);
  outline-offset: 3px;
}

.group-card-image {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center;
  filter: saturate(0.9);
}

.group-card-overlay {
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(12,26,46,0.15) 0%, rgba(12,26,46,0.85) 100%);
}

/* aged map-corner frame inset within the card */
.group-card-frame {
  position: absolute;
  inset: 8px;
  border: 1px dashed rgba(253,240,208,0.35);
  border-radius: 8px;
  pointer-events: none;
  transition: border-color 0.25s ease;
}
.group-card:hover .group-card-frame { border-color: rgba(240,168,50,0.6); }

/* moments-count wax-seal-style badge */
.group-card-badge {
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 1;
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(12,26,46,0.55);
  border: 1px solid rgba(253,240,208,0.35);
  color: var(--parchment);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

/* edit / delete controls, revealed on hover */
.group-card-controls {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 2;
  display: flex;
  gap: 6px;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.group-card:hover .group-card-controls,
.group-card:focus-within .group-card-controls { opacity: 1; }

.group-card-controls button {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: rgba(12,26,46,0.75);
  color: var(--parchment);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.group-card-controls button:hover { background: var(--gold-light); color: #2a1c02; }

.group-card-title {
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: 14px;
  text-align: left;
  font-family: 'Cinzel', serif;
  font-size: 19px;
  color: var(--parchment);
  text-shadow: 0 2px 6px rgba(0,0,0,0.6);
}

.group-card-icon {
  margin-right: 6px;
  font-size: 16px;
  vertical-align: -1px;
}

/* ---------- Modals ---------- */
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(8,15,28,0.65);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  animation: fadeIn 0.2s ease;
}

@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

.modal {
  position: relative;
  background: var(--parchment);
  background-image: repeating-linear-gradient(
    0deg, rgba(0,0,0,0.025) 0px, rgba(0,0,0,0.025) 1px, transparent 1px, transparent 26px
  );
  color: var(--ink);
  border-radius: 16px;
  border: 1px solid var(--sand);
  box-shadow: 0 24px 60px rgba(0,0,0,0.5);
}

.modal.level1, .modal.level2 {
  width: 100%;
  max-width: 760px;
  max-height: 85vh;
  overflow-y: auto;
  padding: 28px 32px 32px;
}

.modal.dialog { width: 100%; max-width: 420px; padding: 28px; }

.modal-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 24px;
  padding-bottom: 16px;
  border-bottom: 1px dashed var(--sand);
}

.modal-header h2 {
  font-family: 'Cinzel', serif;
  font-size: 22px;
  margin: 0 0 4px;
  color: var(--navy);
}

.modal-subtitle { font-size: 13px; font-weight: 700; color: var(--ocean); }

.modal-close, .back-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-family: 'Nunito', sans-serif;
  font-weight: 700;
  color: var(--ink);
}
.modal-close { font-size: 18px; }
.back-btn { font-size: 14px; }

/* Level 1: event folders */
.events-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 18px;
}

.event-folder {
  position: relative;
  padding: 18px 14px 14px;
  border-radius: 12px;
  border: 1px solid var(--sand);
  background: #fff8e8;
  text-align: center;
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.event-folder:hover { transform: translateY(-3px); box-shadow: 0 10px 20px rgba(0,0,0,0.15); }

.event-folder-icon { font-size: 28px; margin-bottom: 8px; }
.event-folder-title { font-weight: 800; font-size: 15px; margin-bottom: 4px; }
.event-folder-date { font-size: 12px; font-weight: 700; color: var(--ocean); }
.event-folder-count { font-size: 11px; color: #8a7a5a; margin-top: 4px; }

.event-folder-controls {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.event-folder:hover .event-folder-controls { opacity: 1; }

.event-folder-controls button {
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: rgba(12,26,46,0.08);
  font-size: 12px;
  cursor: pointer;
}
.event-folder-controls button:hover { background: rgba(12,26,46,0.18); }

.add-folder {
  min-height: 110px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 2px dashed var(--sand);
  background: transparent;
  color: var(--ocean);
  font-weight: 700;
}
.add-folder:hover { border-color: var(--gold); color: var(--gold); }

.add-icon { font-size: 26px; line-height: 1; }

/* Level 2: photo grid */
.photo-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 12px;
}

@media (max-width: 640px) { .photo-grid { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 380px) { .photo-grid { grid-template-columns: repeat(2, 1fr); } }

.photo-slot {
  position: relative;
  aspect-ratio: 1;
  border-radius: 10px;
  overflow: hidden;
  background: #fff8e8;
  border: 1px dashed var(--sand);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.photo-slot img { width: 100%; height: 100%; object-fit: cover; display: block; }

.photo-plus { font-size: 26px; color: var(--sand); }

.photo-remove {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: none;
  background: rgba(12,26,46,0.75);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.photo-slot:hover .photo-remove { opacity: 1; }

.add-slot {
  flex-direction: column;
  gap: 4px;
  border: 2px dashed var(--ocean);
  color: var(--ocean);
  font-weight: 700;
  font-size: 12px;
  background: transparent;
}
.add-slot:hover { border-color: var(--gold); color: var(--gold); }

/* Dialogs */
.modal.dialog h3 { font-family: 'Cinzel', serif; font-size: 19px; margin: 0 0 16px; color: var(--navy); }
.modal.dialog p { font-size: 13px; color: #5a4c33; margin: 0 0 18px; }

.modal.dialog label {
  display: block;
  font-size: 12px;
  font-weight: 700;
  color: var(--ocean);
  margin: 12px 0 6px;
}

.modal.dialog input {
  width: 100%;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--sand);
  background: #fffaf0;
  font-family: 'Nunito', sans-serif;
  font-size: 14px;
  color: var(--ink);
}
.modal.dialog input:focus { outline: 2px solid var(--gold-light); outline-offset: 1px; }

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 22px;
}

/* Footer */
.footer {
  position: relative;
  z-index: 1;
  text-align: center;
  padding: 24px;
  color: rgba(253,240,208,0.5);
  font-size: 13px;
  letter-spacing: 0.03em;
}

@media (prefers-reduced-motion: reduce) {
  .flag, .compass { animation: none; }
}

/* ---------- Lock screen ---------- */
.lock-screen {
  position: relative;
  z-index: 1;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 24px;
  gap: 8px;
}

.lock-card {
  margin-top: 12px;
  width: 100%;
  max-width: 380px;
  background: var(--parchment);
  background-image: repeating-linear-gradient(
    0deg, rgba(0,0,0,0.025) 0px, rgba(0,0,0,0.025) 1px, transparent 1px, transparent 26px
  );
  color: var(--ink);
  border-radius: 16px;
  border: 1px solid var(--sand);
  box-shadow: 0 24px 60px rgba(0,0,0,0.5);
  padding: 32px 28px;
}

.lock-title {
  font-family: 'Cinzel', serif;
  font-size: 28px;
  margin: 0 0 8px;
  color: var(--navy);
}

.lock-subtitle {
  font-size: 14px;
  color: #5a4c33;
  margin: 0 0 20px;
  line-height: 1.5;
}

.lock-card input {
  width: 100%;
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid var(--sand);
  background: #fffaf0;
  font-family: 'Nunito', sans-serif;
  font-size: 15px;
  color: var(--ink);
  text-align: center;
  letter-spacing: 0.04em;
}
.lock-card input:focus { outline: 2px solid var(--gold-light); outline-offset: 1px; }

.lock-error {
  margin-top: 10px;
  font-size: 13px;
  font-weight: 700;
  color: #7a2222;
}

.lock-submit {
  width: 100%;
  margin-top: 18px;
  font-size: 15px;
  padding: 12px 20px;
}

.lock-app .footer { margin-top: 8px; }
`;

/* ============================================================
   Component
   ============================================================ */

const App: React.FC = () => {
  const [isUnlocked, setIsUnlocked] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(AUTH_SESSION_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [passwordInput, setPasswordInput] = useState("");
  const [loginError, setLoginError] = useState(false);
  const passwordInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isUnlocked) {
      passwordInputRef.current?.focus();
    }
  }, [isUnlocked]);

  function handleLoginSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (passwordInput === ACCESS_PASSWORD) {
      setIsUnlocked(true);
      setLoginError(false);
      try {
        sessionStorage.setItem(AUTH_SESSION_KEY, "true");
      } catch {
        /* sessionStorage unavailable — session simply won't persist */
      }
    } else {
      setLoginError(true);
      setPasswordInput("");
    }
  }

  const [groups, setGroups] = useState<Group[]>(() => BUILT_IN_ALBUM_DATA ?? createDefaultGroups());
  const [isAlbumLoaded, setIsAlbumLoaded] = useState(false);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [activeEventId, setActiveEventId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>({ type: "none" });

  const [inputName, setInputName] = useState("");
  const [eventTitleInput, setEventTitleInput] = useState("");
  const [eventDateInput, setEventDateInput] = useState("");

  const [uploadTarget, setUploadTarget] = useState<{
    groupId: string;
    eventId: string;
    slotId: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [importMessage, setImportMessage] = useState<{ type: "success" | "error"; text: string } | null>(
    null
  );

  useEffect(() => {
    if (!importMessage) return;
    const t = setTimeout(() => setImportMessage(null), 4000);
    return () => clearTimeout(t);
  }, [importMessage]);

  const today = new Date();
  const isBirthday = today.getMonth() === 8 && today.getDate() === 11; // September 11
  const heroTitle = isBirthday ? "It's Your Birthday." : "Special Moments";

  const activeGroup = groups.find((g) => g.id === activeGroupId) ?? null;
  const activeEvent = activeGroup?.events.find((e) => e.id === activeEventId) ?? null;

  /* ---------- Persistence: load from IndexedDB (much higher quota) ---------- */
  const [storageWarning, setStorageWarning] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await loadGroupsFromDb();
      if (cancelled) return;

      if (stored && stored.length > 0) {
        setGroups(stored);
      } else {
        // Nothing in IndexedDB yet — check for data left over from an
        // earlier version of this app that used localStorage, and bring
        // it forward so nobody loses their album on the upgrade.
        const legacy = loadLegacyGroupsFromLocalStorage();
        if (legacy) {
          setGroups(legacy);
          try {
            localStorage.removeItem(LEGACY_ALBUM_STORAGE_KEY);
          } catch {
            /* not critical if this fails */
          }
        }
      }
      setIsAlbumLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------- Persistence: stay in sync across tabs/windows on THIS device ---------- */
  const albumChannelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("special-moments-album-sync");
    albumChannelRef.current = channel;
    channel.onmessage = (e) => {
      if (Array.isArray(e.data)) setGroups(e.data as Group[]);
    };
    return () => {
      channel.close();
      albumChannelRef.current = null;
    };
  }, []);

  // Whenever the album changes (after the initial load has completed),
  // save it to IndexedDB so it survives refreshes.
  useEffect(() => {
    if (!isAlbumLoaded) return;
    saveGroupsToDb(groups)
      .then(() => {
        setStorageWarning(null);
        albumChannelRef.current?.postMessage(groups);
      })
      .catch(() => {
        // IndexedDB's quota is much larger than localStorage's, so this
        // should be rare — but the device could still be genuinely full.
        setStorageWarning(
          "Couldn't save your latest change — device storage may be full. Try removing a few photos."
        );
      });
  }, [groups, isAlbumLoaded]);

  /* ---------- Navigation ---------- */
  function openGroup(groupId: string) {
    setActiveGroupId(groupId);
    setActiveEventId(null);
  }
  function closeGroupModal() {
    setActiveGroupId(null);
    setActiveEventId(null);
  }
  function openEvent(eventId: string) {
    setActiveEventId(eventId);
  }
  function closeEventModal() {
    setActiveEventId(null);
  }

  /* ---------- Dialog control ---------- */
  function openDialog(next: DialogState) {
    if (next.type === "newGroup") {
      setInputName("");
    } else if (next.type === "editGroup") {
      const group = groups.find((g) => g.id === next.groupId);
      setInputName(group?.name ?? "");
    } else if (next.type === "newEvent") {
      setEventTitleInput("");
      setEventDateInput("");
    } else if (next.type === "editEvent") {
      const group = groups.find((g) => g.id === next.groupId);
      const ev = group?.events.find((e) => e.id === next.eventId);
      setEventTitleInput(ev?.title ?? "");
      setEventDateInput(ev?.date ?? "");
    }
    setDialog(next);
  }
  function closeDialog() {
    setDialog({ type: "none" });
  }

  /* ---------- Crew (group) actions ---------- */
  function submitGroupDialog() {
    const name = inputName.trim();
    if (!name) return;

    if (dialog.type === "editGroup") {
      const groupId = dialog.groupId;
      setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, name } : g)));
    } else {
      setGroups((prev) => [
        ...prev,
        { id: uid(), name, cover: `https://picsum.photos/seed/${uid()}/500/350`, events: [] },
      ]);
    }
    closeDialog();
  }

  function confirmDeleteGroup(groupId: string, name: string) {
    setDialog({ type: "confirmDeleteGroup", groupId, name });
  }

  function submitDeleteGroup() {
    if (dialog.type !== "confirmDeleteGroup") return;
    const { groupId } = dialog;
    setGroups((prev) => prev.filter((g) => g.id !== groupId));
    if (activeGroupId === groupId) {
      setActiveGroupId(null);
      setActiveEventId(null);
    }
    closeDialog();
  }

  /* ---------- Event (folder) actions ---------- */
  function submitEventDialog() {
    const title = eventTitleInput.trim();
    if (!title || !eventDateInput) return;

    if (dialog.type === "newEvent") {
      const groupId = dialog.groupId;
      setGroups((prev) =>
        prev.map((g) =>
          g.id === groupId
            ? {
                ...g,
                events: [
                  ...g.events,
                  { id: uid(), title, date: eventDateInput, photos: makeEmptyPhotos(5) },
                ],
              }
            : g
        )
      );
    } else if (dialog.type === "editEvent") {
      const { groupId, eventId } = dialog;
      setGroups((prev) =>
        prev.map((g) =>
          g.id === groupId
            ? {
                ...g,
                events: g.events.map((e) =>
                  e.id === eventId ? { ...e, title, date: eventDateInput } : e
                ),
              }
            : g
        )
      );
    }
    closeDialog();
  }

  function confirmDeleteEvent(groupId: string, eventId: string, title: string) {
    setDialog({ type: "confirmDeleteEvent", groupId, eventId, title });
  }

  function submitDeleteEvent() {
    if (dialog.type !== "confirmDeleteEvent") return;
    const { groupId, eventId } = dialog;
    setGroups((prev) =>
      prev.map((g) =>
        g.id === groupId ? { ...g, events: g.events.filter((e) => e.id !== eventId) } : g
      )
    );
    if (activeEventId === eventId) setActiveEventId(null);
    closeDialog();
  }

  /* ---------- Photo actions ---------- */
  function addPhotoSlot(groupId: string, eventId: string) {
    setGroups((prev) =>
      prev.map((g) =>
        g.id === groupId
          ? {
              ...g,
              events: g.events.map((e) =>
                e.id === eventId ? { ...e, photos: [...e.photos, { id: uid(), url: null }] } : e
              ),
            }
          : g
      )
    );
  }

  function triggerUpload(groupId: string, eventId: string, slotId: string) {
    setUploadTarget({ groupId, eventId, slotId });
    fileInputRef.current?.click();
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const target = uploadTarget;

    if (file && target) {
      // Read the file as a base64 data URL instead of a blob object URL.
      // Blob URLs (URL.createObjectURL) can silently fail to render inside
      // sandboxed preview frames and are tied to the document that created
      // them, which is why uploaded photos sometimes never appeared. A data
      // URL is a plain string that always renders and survives re-renders.
      const reader = new FileReader();
      reader.onload = () => {
        const url = typeof reader.result === "string" ? reader.result : null;
        if (!url) return;
        const { groupId, eventId, slotId } = target;
        setGroups((prev) =>
          prev.map((g) =>
            g.id === groupId
              ? {
                  ...g,
                  events: g.events.map((ev) =>
                    ev.id === eventId
                      ? {
                          ...ev,
                          photos: ev.photos.map((p) => (p.id === slotId ? { ...p, url } : p)),
                        }
                      : ev
                  ),
                }
              : g
          )
        );
      };
      reader.readAsDataURL(file);
    }

    setUploadTarget(null);
    e.target.value = "";
  }

  function removePhoto(groupId: string, eventId: string, slotId: string) {
    setGroups((prev) =>
      prev.map((g) =>
        g.id === groupId
          ? {
              ...g,
              events: g.events.map((ev) =>
                ev.id === eventId
                  ? { ...ev, photos: ev.photos.map((p) => (p.id === slotId ? { ...p, url: null } : p)) }
                  : ev
              ),
            }
          : g
      )
    );
  }

  /* ---------- Export / Import (no-cloud sharing) ---------- */
  function exportAlbum() {
    const dataStr = JSON.stringify(groups, null, 2);
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "special-moments-album.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function triggerImport() {
    importInputRef.current?.click();
  }

  function handleImportFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = typeof reader.result === "string" ? reader.result : "";
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) throw new Error("Not an album array");
        setGroups(parsed as Group[]);
        setImportMessage({ type: "success", text: "Album imported!" });
      } catch {
        setImportMessage({
          type: "error",
          text: "That file doesn't look like a valid album export.",
        });
      }
    };
    reader.readAsText(file);
  }

  /* ============================================================
     Render
     ============================================================ */

  if (!isUnlocked) {
    return (
      <div className="app lock-app">
        <style>{styles}</style>
        <div className="lock-screen">
          <span className="compass" aria-hidden="true">
            🧭
          </span>
          <span className="flag" aria-hidden="true">
            🏴‍☠️
          </span>
          <div className="lock-card">
            <h1 className="lock-title">Special Moments</h1>
            <p className="lock-subtitle">This treasure chest is locked. Enter the password to come aboard.</p>
            <form onSubmit={handleLoginSubmit}>
              <input
                ref={passwordInputRef}
                type="password"
                value={passwordInput}
                onChange={(e) => {
                  setPasswordInput(e.target.value);
                  if (loginError) setLoginError(false);
                }}
                placeholder="Password"
                aria-label="Password"
                autoComplete="current-password"
              />
              {loginError && <div className="lock-error">Wrong password, matey. Try again.</div>}
              <button type="submit" className="btn btn-gold lock-submit" disabled={!passwordInput}>
                Unlock ⚓
              </button>
            </form>
          </div>
          <footer className="footer">✦ © 2026 · Made by anton lomo ✦</footer>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <style>{styles}</style>

      {/* Hero */}
      <header className="hero">
        <span className="compass" aria-hidden="true">
          🧭
        </span>
        <span className="flag" aria-hidden="true">
          🏴‍☠️
        </span>
        <div className="date-pill">{formatBadgeDate(today)}</div>
        <h1 className="hero-title">{heroTitle}</h1>
        <p className="hero-subtitle">
          Your memories deserve a place to live forever.
        </p>
      </header>

      {/* Crew grid */}
      <main className="content">
        {storageWarning && <div className="storage-warning">⚠ {storageWarning}</div>}
        {importMessage && (
          <div className={importMessage.type === "success" ? "import-success" : "storage-warning"}>
            {importMessage.type === "success" ? "✓" : "⚠"} {importMessage.text}
          </div>
        )}

        <div className="section-header">
          <h2>Your Crews</h2>
          <div className="section-header-actions">
            <button type="button" className="btn btn-ghost" onClick={exportAlbum} title="Download this album as a file">
              ⬇ Export Album
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={triggerImport}
              title="Load an album file exported earlier"
            >
              ⬆ Import Album
            </button>
            <button type="button" className="btn btn-gold" onClick={() => openDialog({ type: "newGroup" })}>
              + New Crew
            </button>
          </div>
        </div>

        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          onChange={handleImportFileChange}
        />

        <div className="groups-grid">
          {groups.map((group) => (
            <div
              key={group.id}
              className="group-card"
              role="button"
              tabIndex={0}
              onClick={() => openGroup(group.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openGroup(group.id);
                }
              }}
            >
              <div className="group-card-image" style={{ backgroundImage: `url(${group.cover})` }} />
              <div className="group-card-overlay" />
              <div className="group-card-frame" aria-hidden="true" />

              <div className="group-card-badge">
                {group.events.length} {group.events.length === 1 ? "moment" : "moments"}
              </div>

              <div className="group-card-controls" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  onClick={() => openDialog({ type: "editGroup", groupId: group.id })}
                  aria-label="Edit crew name"
                >
                  ✎
                </button>
                <button
                  type="button"
                  onClick={() => confirmDeleteGroup(group.id, group.name)}
                  aria-label="Delete crew"
                >
                  🗑
                </button>
              </div>

              <div className="group-card-title">
                <span className="group-card-icon" aria-hidden="true">
                  ⚓
                </span>
                {group.name}
              </div>
            </div>
          ))}
        </div>
      </main>

      <footer className="footer">✦ © 2026 · Made by anton lomo ✦</footer>

      {/* Level 1 modal: folder / moment selector */}
      {activeGroup && !activeEvent && (
        <div className="modal-backdrop" onClick={closeGroupModal}>
          <div className="modal level1" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2>Choose Your Adventure</h2>
                <span className="modal-subtitle">{activeGroup.name}</span>
              </div>
              <button type="button" className="modal-close" onClick={closeGroupModal}>
                ✕
              </button>
            </div>

            <div className="events-grid">
              {activeGroup.events.map((ev) => (
                <div key={ev.id} className="event-folder" onClick={() => openEvent(ev.id)}>
                  <div className="event-folder-controls" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      onClick={() => openDialog({ type: "editEvent", groupId: activeGroup.id, eventId: ev.id })}
                      aria-label="Edit event"
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      onClick={() => confirmDeleteEvent(activeGroup.id, ev.id, ev.title)}
                      aria-label="Delete event"
                    >
                      🗑
                    </button>
                  </div>
                  <div className="event-folder-icon">🗺️</div>
                  <div className="event-folder-title">{ev.title}</div>
                  <div className="event-folder-date">{formatEventDate(ev.date)}</div>
                  <div className="event-folder-count">
                    {ev.photos.filter((p) => p.url).length} photos
                  </div>
                </div>
              ))}

              <button
                type="button"
                className="event-folder add-folder"
                onClick={() => openDialog({ type: "newEvent", groupId: activeGroup.id })}
              >
                <span className="add-icon">+</span>
                <span>Add Event</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Level 2 modal: photo gallery */}
      {activeGroup && activeEvent && (
        <div className="modal-backdrop" onClick={closeEventModal}>
          <div className="modal level2" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <button type="button" className="back-btn" onClick={closeEventModal}>
                ← Back
              </button>
              <div style={{ textAlign: "right" }}>
                <h2>{activeEvent.title}</h2>
                <span className="modal-subtitle">{formatEventDate(activeEvent.date)}</span>
              </div>
            </div>

            <div className="photo-grid">
              {activeEvent.photos.map((photo) => (
                <div
                  key={photo.id}
                  className="photo-slot"
                  onClick={() =>
                    !photo.url && triggerUpload(activeGroup.id, activeEvent.id, photo.id)
                  }
                >
                  {photo.url ? (
                    <>
                      <img src={photo.url} alt="" />
                      <button
                        type="button"
                        className="photo-remove"
                        onClick={(e) => {
                          e.stopPropagation();
                          removePhoto(activeGroup.id, activeEvent.id, photo.id);
                        }}
                        aria-label="Remove photo"
                      >
                        ✕
                      </button>
                    </>
                  ) : (
                    <span className="photo-plus">+</span>
                  )}
                </div>
              ))}

              <button
                type="button"
                className="photo-slot add-slot"
                onClick={() => addPhotoSlot(activeGroup.id, activeEvent.id)}
              >
                <span className="add-icon">+</span>
                <span>Add picture</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New / edit crew dialog */}
      {(dialog.type === "newGroup" || dialog.type === "editGroup") && (
        <div className="modal-backdrop" onClick={closeDialog}>
          <div className="modal dialog" onClick={(e) => e.stopPropagation()}>
            <h3>{dialog.type === "editGroup" ? "Rename Your Crew" : "Name Your Crew"}</h3>
            <input
              autoFocus
              value={inputName}
              onChange={(e) => setInputName(e.target.value)}
              placeholder="e.g. Beach Buddies"
            />
            <div className="dialog-actions">
              <button type="button" className="btn btn-ghost" onClick={closeDialog}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-gold"
                onClick={submitGroupDialog}
                disabled={!inputName.trim()}
              >
                {dialog.type === "editGroup" ? "Save Changes" : "Create Crew"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm delete crew dialog */}
      {dialog.type === "confirmDeleteGroup" && (
        <div className="modal-backdrop" onClick={closeDialog}>
          <div className="modal dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Remove &ldquo;{dialog.name}&rdquo;?</h3>
            <p>This will permanently delete this crew along with all of its events and photos.</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-ghost" onClick={closeDialog}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" onClick={submitDeleteGroup}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New / edit event dialog */}
      {(dialog.type === "newEvent" || dialog.type === "editEvent") && (
        <div className="modal-backdrop" onClick={closeDialog}>
          <div className="modal dialog" onClick={(e) => e.stopPropagation()}>
            <h3>{dialog.type === "editEvent" ? "Edit Event" : "New Event"}</h3>

            <label htmlFor="event-title-input">Event Title</label>
            <input
              id="event-title-input"
              autoFocus
              value={eventTitleInput}
              onChange={(e) => setEventTitleInput(e.target.value)}
              placeholder="e.g. Summer Bonfire"
            />

            <label htmlFor="event-date-input">Event Date</label>
            <input
              id="event-date-input"
              type="date"
              value={eventDateInput}
              onChange={(e) => setEventDateInput(e.target.value)}
            />

            <div className="dialog-actions">
              <button type="button" className="btn btn-ghost" onClick={closeDialog}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-gold"
                onClick={submitEventDialog}
                disabled={!eventTitleInput.trim() || !eventDateInput}
              >
                {dialog.type === "editEvent" ? "Save Changes" : "Add Event"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm delete dialog */}
      {dialog.type === "confirmDeleteEvent" && (
        <div className="modal-backdrop" onClick={closeDialog}>
          <div className="modal dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Remove &ldquo;{dialog.title}&rdquo;?</h3>
            <p>This will permanently delete this event and all its photos.</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-ghost" onClick={closeDialog}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" onClick={submitDeleteEvent}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hidden file input used for photo uploads */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={handleFileChange}
      />
    </div>
  );
};

export default App;

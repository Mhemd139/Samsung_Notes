import { formatDate as isoDate } from "../../src/text";
import { canShareFiles, downloadBlob, exportZip, noteFileName, notePdf, pdfFile } from "./exporters";
import { formatDate, LANGUAGES, preferredLanguage, setLanguage, t } from "./i18n";
import { droppedFiles, sortFiles } from "./intake";
import { openNote, readNote, svgUrl, type LibraryNote, type OpenNote } from "./library";
import { loadParser } from "./parser";
import { renderNoteText } from "./text-view";

type View = "home" | "library" | "note";
type Tab = "pages" | "text" | "files";

interface CurrentNote {
  note: LibraryNote;
  open: OpenNote;
  urls: string[];
  fileUrls: Map<string, string>;
  observer: IntersectionObserver;
  pdf?: Uint8Array;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

interface LaunchQueue {
  setConsumer(consumer: (params: { files: FileSystemFileHandle[] }) => void): void;
}

const SHARE_CACHE = "inkport-shared";
const TOAST_MS = 4000;
const MAX_LISTED_PROBLEMS = 3;
const IMAGE_TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
const AUDIO_TYPES: Record<string, string> = { m4a: "audio/mp4", mp3: "audio/mpeg", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", "3gp": "audio/3gpp" };

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const ui = {
  views: { home: byId("home"), library: byId("library"), note: byId("note") } satisfies Record<View, HTMLElement>,
  fileInput: byId<HTMLInputElement>("file-input"),
  grid: byId("grid"),
  search: byId<HTMLInputElement>("search"),
  noMatches: byId("no-matches"),
  libraryTitle: byId("library-title"),
  exportAll: byId<HTMLButtonElement>("export-all"),
  noteTitle: byId("note-title"),
  noteMeta: byId("note-meta"),
  share: byId<HTMLButtonElement>("share"),
  pdf: byId<HTMLButtonElement>("pdf"),
  copy: byId<HTMLButtonElement>("copy"),
  aiTip: byId("ai-tip"),
  tabs: { pages: byId("tab-pages"), text: byId("tab-text"), files: byId("tab-files") } satisfies Record<Tab, HTMLElement>,
  panels: { pages: byId("panel-pages"), text: byId("panel-text"), files: byId("panel-files") } satisfies Record<Tab, HTMLElement>,
  filesCount: byId("files-count"),
  language: byId<HTMLSelectElement>("language"),
  install: byId<HTMLButtonElement>("install"),
  installHint: byId("install-hint"),
  dropOverlay: byId("drop-overlay"),
  toast: byId("toast"),
  toastText: byId("toast-text"),
  toastAction: byId<HTMLButtonElement>("toast-action"),
};

const state = {
  notes: [] as LibraryNote[],
  current: undefined as CurrentNote | undefined,
  busy: false,
  libraryScroll: 0,
  canShare: false,
  installPrompt: undefined as BeforeInstallPromptEvent | undefined,
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const element = Object.assign(document.createElement(tag), props);
  element.append(...children);
  return element;
}

const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

// ── Views ────────────────────────────────────────────────────────────────

function show(view: View, scrollTo = 0): void {
  for (const [name, element] of Object.entries(ui.views)) element.hidden = name !== view;
  document.body.dataset.view = view;
  window.scrollTo({ top: scrollTo });
}

// ── Opening files ───────────────────────────────────────────────────────

async function addFiles(files: File[]): Promise<void> {
  if (!files.length || state.busy) return;
  state.busy = true;
  try {
    const { notes: incoming, problems } = await sortFiles(files);
    const messages = problems.map(({ name, reason }) => t(reason, { name }));
    const added: LibraryNote[] = [];
    if (incoming.length) await loadParser();
    for (const [index, file] of incoming.entries()) {
      progress(t("opening", { done: index + 1, count: incoming.length }));
      try {
        added.push(await readNote(file));
      } catch (error) {
        console.error(`Couldn't open ${file.name}`, error);
        messages.push(t("cantOpen", { name: file.name }));
      }
      await pause();
    }
    if (messages.length) {
      const more = messages.length > MAX_LISTED_PROBLEMS ? "\n…" : "";
      toast(messages.slice(0, MAX_LISTED_PROBLEMS).join("\n") + more, { error: true });
    } else {
      hideToast();
    }
    if (!added.length) return;
    state.notes = [...state.notes, ...added].sort((a, b) => (b.modifiedMs ?? 0) - (a.modifiedMs ?? 0));
    renderLibrary();
    if (state.notes.length === 1) await showNote(added[0]!);
    else if (!state.current) show("library");
  } catch (error) {
    console.error(error);
    toast(t("failed"), { error: true });
  } finally {
    state.busy = false;
  }
}

async function takeSharedFiles(): Promise<File[]> {
  if (!new URLSearchParams(location.search).has("shared") || !("caches" in window)) return [];
  history.replaceState(null, "", location.pathname);
  const cache = await caches.open(SHARE_CACHE);
  const files: File[] = [];
  for (const request of await cache.keys()) {
    const response = await cache.match(request);
    if (response) {
      const name = decodeURIComponent(response.headers.get("X-File-Name") ?? "note.sdocx");
      files.push(new File([await response.blob()], name));
    }
    await cache.delete(request);
  }
  return files;
}

// ── Library ─────────────────────────────────────────────────────────────

function renderLibrary(): void {
  const query = ui.search.value.trim().toLocaleLowerCase();
  const visible = query ? state.notes.filter((note) => note.searchText.includes(query)) : state.notes;
  ui.libraryTitle.textContent = t("libraryTitle", { count: state.notes.length });
  ui.grid.replaceChildren(...visible.map(card));
  ui.noMatches.hidden = visible.length > 0;
}

function card(note: LibraryNote): HTMLLIElement {
  const details = [note.modifiedMs === null ? "" : formatDate(note.modifiedMs), t("pages", { count: note.pageCount })];
  const badges = [
    ...(note.inkPages.length ? [el("span", { className: "badge" }, t("handwriting"))] : []),
    ...(note.attachments.length ? [el("span", { className: "badge" }, t("files", { count: note.attachments.length }))] : []),
  ];
  const button = el(
    "button",
    { className: "card", type: "button" },
    el("span", { className: "thumb" }, ...(note.thumbnail ? [el("img", { src: note.thumbnail, alt: "", loading: "lazy", decoding: "async" })] : [])),
    el(
      "span",
      { className: "card-body" },
      el("span", { className: "card-title" }, note.title),
      el("span", { className: "card-meta" }, details.filter(Boolean).join(" · ")),
      ...(badges.length ? [el("span", { className: "badges" }, ...badges)] : []),
    ),
  );
  button.dataset.id = String(note.id);
  button.addEventListener("click", () => void showNote(note));
  return el("li", {}, button);
}

function closeAll(): void {
  closeNote();
  for (const note of state.notes) if (note.thumbnail) URL.revokeObjectURL(note.thumbnail);
  state.notes = [];
  ui.search.value = "";
  history.replaceState(null, "", location.pathname);
  show("home");
}

// ── Note ────────────────────────────────────────────────────────────────

async function showNote(note: LibraryNote, push = true): Promise<void> {
  let open: OpenNote;
  try {
    open = await openNote(note);
  } catch (error) {
    console.error(`Couldn't open ${note.title}`, error);
    toast(t("cantOpen", { name: note.file.name }), { error: true });
    return;
  }
  if (!ui.views.note.hidden) closeNote();
  else state.libraryScroll = window.scrollY;
  const observer = new IntersectionObserver(paintVisiblePages, { rootMargin: "1200px 0px" });
  state.current = { note, open, urls: [], fileUrls: new Map(), observer };
  ui.noteTitle.textContent = note.title;
  ui.filesCount.textContent = note.attachments.length ? String(note.attachments.length) : "";
  ui.share.hidden = !state.canShare;
  ui.copy.hidden = !note.text;
  ui.aiTip.hidden = !note.inkPages.length;
  renderNoteTexts();
  renderPages();
  selectTab("pages", false);
  if (push) history.pushState({ note: note.id }, "");
  show("note");
  ui.noteTitle.focus({ preventScroll: true });
}

function closeNote(): void {
  const current = state.current;
  if (!current) return;
  current.observer.disconnect();
  [...current.urls, ...current.fileUrls.values()].forEach((url) => URL.revokeObjectURL(url));
  current.open.close();
  state.current = undefined;
}

function backToLibrary(): void {
  const id = state.current?.note.id;
  closeNote();
  renderLibrary();
  show("library", state.libraryScroll);
  ui.grid.querySelector<HTMLElement>(`[data-id="${id}"]`)?.focus({ preventScroll: true });
}

// Texts that depend on the language, so they are redrawn when it changes.
function renderNoteTexts(): void {
  const current = state.current;
  if (!current) return;
  const { note, open } = current;
  ui.noteMeta.textContent = [
    note.modifiedMs === null ? "" : t("edited", { date: formatDate(note.modifiedMs) }),
    t("pages", { count: note.pageCount }),
  ]
    .filter(Boolean)
    .join(" · ");
  ui.panels.pages.querySelectorAll("img").forEach((image, index) => {
    image.alt = t("pageAlt", { page: index + 1, count: open.pageCount });
  });
  ui.panels.text.replaceChildren(
    note.text ? renderNoteText(note.text, (name) => (imageType(name) ? attachmentUrl(name) : undefined)) : el("p", { className: "empty" }, t("noText")),
  );
  ui.panels.files.replaceChildren(
    note.attachments.length ? el("ul", { className: "file-list" }, ...note.attachments.map(({ name, size }) => fileItem(name, size))) : el("p", { className: "empty" }, t("noFiles")),
  );
}

function renderPages(): void {
  const current = state.current!;
  const figures = Array.from({ length: current.open.pageCount }, (_, index) => {
    const figure = el(
      "figure",
      { className: "page" },
      el("img", { alt: t("pageAlt", { page: index + 1, count: current.open.pageCount }), decoding: "async" }),
      el("figcaption", {}, `${(index + 1).toLocaleString()} / ${current.open.pageCount.toLocaleString()}`),
    );
    figure.dataset.index = String(index);
    current.observer.observe(figure);
    return figure;
  });
  ui.panels.pages.replaceChildren(...figures);
}

function paintVisiblePages(entries: IntersectionObserverEntry[]): void {
  const current = state.current;
  if (!current) return;
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const figure = entry.target as HTMLElement;
    current.observer.unobserve(figure);
    try {
      const url = svgUrl(current.open.page(Number(figure.dataset.index)));
      current.urls.push(url);
      figure.querySelector("img")!.src = url;
      figure.classList.add("loaded");
    } catch (error) {
      console.error(`Couldn't draw page ${Number(figure.dataset.index) + 1}`, error);
      figure.classList.add("failed");
    }
  }
}

function fileItem(name: string, size: number): HTMLLIElement {
  const label = name.replace(/^\d+@/, "");
  const meta = el("span", { className: "file-meta" }, el("span", { className: "file-name" }, label), el("span", { className: "file-size" }, formatSize(size)));
  const download = el("button", { className: "button small", type: "button" }, t("downloadFile"));
  download.addEventListener("click", () => {
    const bytes = state.current?.open.attachment(name);
    if (bytes) downloadBlob(new Blob([bytes as BlobPart], { type: mimeType(name) }), label);
  });
  const preview = imageType(name)
    ? el("img", { className: "file-preview", src: attachmentUrl(name) ?? "", alt: "", loading: "lazy" })
    : audioType(name)
      ? el("audio", { controls: true, preload: "none", src: attachmentUrl(name) ?? "" })
      : undefined;
  const actions = el("span", { className: "file-actions" });
  if (/\.pdf$/i.test(name)) {
    const openButton = el("button", { className: "button small", type: "button" }, t("openFile"));
    openButton.addEventListener("click", () => {
      const url = attachmentUrl(name);
      if (url) window.open(url, "_blank", "noopener");
    });
    actions.append(openButton);
  }
  actions.append(download);
  return el("li", { className: "file" }, ...(preview ? [preview] : []), meta, actions);
}

function attachmentUrl(name: string): string | undefined {
  const current = state.current;
  if (!current) return undefined;
  const cached = current.fileUrls.get(name);
  if (cached) return cached;
  const bytes = current.open.attachment(name);
  if (!bytes) return undefined;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType(name) }));
  current.fileUrls.set(name, url);
  return url;
}

const extension = (name: string): string => name.slice(name.lastIndexOf(".") + 1).toLowerCase();
const imageType = (name: string): string | undefined => IMAGE_TYPES[extension(name)];
const audioType = (name: string): string | undefined => AUDIO_TYPES[extension(name)];
const mimeType = (name: string): string =>
  imageType(name) ?? audioType(name) ?? (extension(name) === "pdf" ? "application/pdf" : "application/octet-stream");

function formatSize(bytes: number): string {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;
  const power = Math.min(units.length - 1, Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)));
  return new Intl.NumberFormat(document.documentElement.lang, { style: "unit", unit: units[power], maximumFractionDigits: 1 }).format(
    bytes / 1024 ** power,
  );
}

function selectTab(tab: Tab, focus = true): void {
  for (const [name, button] of Object.entries(ui.tabs) as [Tab, HTMLElement][]) {
    const selected = name === tab;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    ui.panels[name].hidden = !selected;
  }
  if (focus) ui.tabs[tab].focus();
}

function moveTab(event: KeyboardEvent): void {
  const order: Tab[] = ["pages", "text", "files"];
  const current = order.findIndex((tab) => ui.tabs[tab] === document.activeElement);
  if (current === -1) return;
  const forward = document.documentElement.dir === "rtl" ? "ArrowLeft" : "ArrowRight";
  const backward = document.documentElement.dir === "rtl" ? "ArrowRight" : "ArrowLeft";
  const next = { [forward]: current + 1, [backward]: current - 1, Home: 0, End: order.length - 1 }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  selectTab(order[(next + order.length) % order.length]!);
}

// ── Actions ─────────────────────────────────────────────────────────────

async function currentPdf(): Promise<Uint8Array> {
  const current = state.current!;
  current.pdf ??= await notePdf(current.note, (done, count) => progress(t("makingPdf", { done, count })));
  return current.pdf;
}

async function sharePdf(): Promise<void> {
  const note = state.current!.note;
  const pdf = await currentPdf();
  hideToast();
  try {
    await navigator.share({ files: [pdfFile(pdf, note)], title: note.title });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    // Making the PDF took long enough for the browser to forget the tap; one more tap shares it.
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      toast(t("pdfReady"), { action: { label: t("share"), run: () => void runAction(sharePdf) } });
      return;
    }
    throw error;
  }
}

async function downloadPdf(): Promise<void> {
  const note = state.current!.note;
  const pdf = await currentPdf();
  downloadBlob(new Blob([pdf as BlobPart], { type: "application/pdf" }), `${noteFileName(note)}.pdf`);
  hideToast();
}

async function copyText(): Promise<void> {
  const { note } = state.current!;
  await navigator.clipboard.writeText(`${note.title}\n\n${note.text}`);
  toast(t("copied"));
}

async function exportAll(): Promise<void> {
  const blob = await exportZip(state.notes, (done, count) => progress(t("exporting", { done, count })));
  downloadBlob(blob, `Notes export ${isoDate(Date.now())}.zip`);
  toast(t("exported"));
}

async function runAction(action: () => Promise<void>, button?: HTMLButtonElement): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  if (button) button.disabled = true;
  try {
    await action();
  } catch (error) {
    console.error(error);
    toast(t("failed"), { error: true });
  } finally {
    state.busy = false;
    if (button) button.disabled = false;
  }
}

// ── Toast ───────────────────────────────────────────────────────────────

let toastTimer: number | undefined;

function toast(message: string, options: { error?: boolean; action?: { label: string; run: () => void } } = {}): void {
  clearTimeout(toastTimer);
  ui.toastText.textContent = message;
  ui.toast.classList.toggle("error", Boolean(options.error));
  ui.toastAction.hidden = !options.action;
  if (options.action) {
    const { label, run } = options.action;
    ui.toastAction.textContent = label;
    ui.toastAction.onclick = () => {
      hideToast();
      run();
    };
  }
  ui.toast.hidden = false;
  if (!options.error && !options.action) toastTimer = window.setTimeout(hideToast, TOAST_MS);
}

function progress(message: string): void {
  clearTimeout(toastTimer);
  ui.toastText.textContent = message;
  ui.toast.classList.remove("error");
  ui.toastAction.hidden = true;
  ui.toast.hidden = false;
}

function hideToast(): void {
  clearTimeout(toastTimer);
  ui.toast.hidden = true;
}

// ── Wiring ──────────────────────────────────────────────────────────────

function wireEvents(): void {
  const chooseFiles = () => ui.fileInput.click();
  byId("open").addEventListener("click", chooseFiles);
  byId("add").addEventListener("click", chooseFiles);
  ui.fileInput.addEventListener("change", () => {
    const files = [...(ui.fileInput.files ?? [])];
    ui.fileInput.value = "";
    void addFiles(files);
  });
  ui.exportAll.addEventListener("click", () => void runAction(exportAll, ui.exportAll));
  byId("close-all").addEventListener("click", closeAll);
  byId("back").addEventListener("click", () => (history.state?.note ? history.back() : backToLibrary()));
  ui.share.addEventListener("click", () => void runAction(sharePdf, ui.share));
  ui.pdf.addEventListener("click", () => void runAction(downloadPdf, ui.pdf));
  ui.copy.addEventListener("click", () => void runAction(copyText));
  for (const [name, button] of Object.entries(ui.tabs) as [Tab, HTMLElement][]) {
    button.addEventListener("click", () => selectTab(name));
    button.addEventListener("keydown", moveTab);
  }
  let searchTimer: number | undefined;
  ui.search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(renderLibrary, 120);
  });
  byId("toast-close").addEventListener("click", hideToast);
  ui.language.addEventListener("change", () => void changeLanguage(ui.language.value));

  window.addEventListener("popstate", (event) => {
    const id = (event.state as { note?: number } | null)?.note;
    const note = state.notes.find((candidate) => candidate.id === id);
    if (note) void showNote(note, false);
    else if (state.current) backToLibrary();
  });

  let dragDepth = 0;
  const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;
  window.addEventListener("dragenter", (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth++;
    ui.dropOverlay.hidden = false;
  });
  window.addEventListener("dragover", (event) => {
    if (carriesFiles(event)) event.preventDefault();
  });
  window.addEventListener("dragleave", (event) => {
    if (!carriesFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) ui.dropOverlay.hidden = true;
  });
  window.addEventListener("drop", (event) => {
    if (!carriesFiles(event) || !event.dataTransfer) return;
    event.preventDefault();
    dragDepth = 0;
    ui.dropOverlay.hidden = true;
    droppedFiles(event.dataTransfer).then(addFiles, (error: unknown) => {
      console.error(error);
      toast(t("failed"), { error: true });
    });
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installPrompt = event as BeforeInstallPromptEvent;
    ui.install.hidden = false;
    ui.installHint.hidden = !/Android/i.test(navigator.userAgent);
  });
  ui.install.addEventListener("click", () => {
    void state.installPrompt?.prompt();
    state.installPrompt = undefined;
    ui.install.hidden = true;
  });
  window.addEventListener("appinstalled", () => {
    ui.install.hidden = true;
    ui.installHint.hidden = true;
  });
}

async function changeLanguage(code: string): Promise<void> {
  try {
    await setLanguage(code);
  } catch (error) {
    console.error(`Couldn't load the ${code} translation`, error);
    toast(t("failed"), { error: true });
    ui.language.value = document.documentElement.lang;
    return;
  }
  renderLibrary();
  renderNoteTexts();
}

async function start(): Promise<void> {
  ui.language.replaceChildren(...LANGUAGES.map(([code, name]) => el("option", { value: code, lang: code }, name)));
  const code = preferredLanguage();
  ui.language.value = code;
  if (code !== "en") await changeLanguage(code);
  state.canShare = canShareFiles();
  wireEvents();
  if ("serviceWorker" in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register("./sw.js").catch((error: unknown) => console.error("Offline support is unavailable", error));
  }
  (window as Window & { launchQueue?: LaunchQueue }).launchQueue?.setConsumer(({ files }) => {
    void Promise.all(files.map((handle) => handle.getFile())).then(addFiles);
  });
  const shared = await takeSharedFiles();
  if (shared.length) await addFiles(shared);
}

void start();

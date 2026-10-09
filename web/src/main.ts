import { formatDate as isoDate } from "../../src/core/text";
import { buildAiPack, type AiPack } from "./aiPack";
import { canShareFiles, downloadBlob, exportZip, noteFileName, notePdf } from "./exporters";
import { audioType, imageType, mimeType } from "./fileTypes";
import { formatDate, language, LANGUAGES, preferredLanguage, setLanguage, t } from "./i18n";
import { droppedFiles, sortFiles } from "./intake";
import { blobOf, openNote, readNote, svgUrl, type Attachment, type LibraryNote, type OpenNote } from "./library";
import { loadParser } from "./parser";
import { displayName, renderNoteText } from "./text-view";

type View = "home" | "library" | "note";
type Tab = "pages" | "text" | "files";

interface CurrentNote {
  note: LibraryNote;
  open: OpenNote;
  urls: string[];
  fileUrls: Map<string, string>;
  observer: IntersectionObserver;
  rendered: Set<Tab>;
  pdf?: Uint8Array;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

interface LaunchQueue {
  setConsumer(consumer: (params: { files: FileSystemFileHandle[] }) => void): void;
}

const SHARE_CACHE = "inkport-shared";
const SAMPLES = ["04-marker4-highlighter", "03-image-placement", "02-shapes-and-dot-calibration", "01-basic-formatting"];
const TOAST_MS = 4000;
const MAX_LISTED = 3;

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`The page is missing #${id}.`);
  return element as T;
}

const ui = {
  views: { home: byId("home"), library: byId("library"), note: byId("note") } satisfies Record<View, HTMLElement>,
  fileInput: byId<HTMLInputElement>("file-input"),
  grid: byId("grid"),
  search: byId<HTMLInputElement>("search"),
  noMatches: byId("no-matches"),
  libraryTitle: byId("library-title"),
  exportAll: byId<HTMLButtonElement>("export-all"),
  closeAll: byId<HTMLButtonElement>("close-all"),
  sendAll: byId<HTMLButtonElement>("send-all"),
  sendAllLabel: byId("send-all-label"),
  aiHint: byId("ai-hint"),
  noteTitle: byId("note-title"),
  noteMeta: byId("note-meta"),
  send: byId<HTMLButtonElement>("send"),
  share: byId<HTMLButtonElement>("share"),
  pdf: byId<HTMLButtonElement>("pdf"),
  copy: byId<HTMLButtonElement>("copy"),
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
  status: byId("status"),
  alert: byId("alert"),
};

const state = {
  notes: [] as LibraryNote[],
  visible: [] as LibraryNote[],
  current: undefined as CurrentNote | undefined,
  busy: false,
  opening: 0,
  libraryScroll: 0,
  canShare: false,
  pack: undefined as (AiPack & { key: string }) | undefined,
  installPrompt: undefined as BeforeInstallPromptEvent | undefined,
};

// Files that arrive while others are still opening wait their turn instead of being dropped.
let intake: Promise<void> = Promise.resolve();

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

const listed = (items: string[], separator: string): string =>
  items.slice(0, MAX_LISTED).join(separator) + (items.length > MAX_LISTED ? `${separator}…` : "");

const count = (value: number): string => value.toLocaleString(language());

// ── Views ────────────────────────────────────────────────────────────────

function show(view: View, scrollTo = 0): void {
  for (const [name, element] of Object.entries(ui.views)) element.hidden = name !== view;
  document.body.dataset.view = view;
  window.scrollTo({ top: scrollTo });
}

// ── Opening files ───────────────────────────────────────────────────────

function addFiles(files: File[]): Promise<void> {
  intake = intake.then(() => openFiles(files));
  return intake;
}

async function openFiles(files: File[]): Promise<void> {
  if (!files.length) return;
  try {
    const { notes: incoming, problems } = await sortFiles(files);
    const messages = problems.map(({ name, reason }) => t(reason, { name }));
    const added: LibraryNote[] = [];
    if (incoming.length) await loadParser();
    for (const [index, file] of incoming.entries()) {
      progress(t("opening", { done: index + 1, count: incoming.length }), index === 0);
      try {
        added.push(await readNote(file));
      } catch (error) {
        console.error(`Couldn't open ${file.name}`, error);
        messages.push(t("cantOpen", { name: file.name }));
      }
      await pause();
    }
    if (messages.length) toast(listed(messages, "\n"), { error: true });
    else hideToast();
    if (!added.length) return;
    state.notes = [...state.notes, ...added].sort((a, b) => (b.modifiedMs ?? 0) - (a.modifiedMs ?? 0));
    renderLibrary();
    if (state.notes.length === 1) {
      await showNote(added[0]!);
    } else if (!state.current) {
      show("library");
      ui.libraryTitle.focus({ preventScroll: true });
    }
  } catch (error) {
    console.error(error);
    toast(t("failed"), { error: true });
  }
}

// Public test notes from the SDOCX Compatibility Corpus, so anyone can try Inkport without a Samsung device.
async function openSamples(): Promise<void> {
  const files = await Promise.all(
    SAMPLES.map(async (name) => {
      const response = await fetch(`./samples/${name}.sdocx`);
      if (!response.ok) throw new Error(`Sample ${name} answered ${response.status}.`);
      return new File([await response.blob()], `${name}.sdocx`);
    }),
  );
  await addFiles(files);
}

// Returns undefined when the page wasn't opened by Android's share sheet.
async function takeSharedFiles(): Promise<File[] | undefined> {
  if (!new URLSearchParams(location.search).has("shared") || !("caches" in window)) return undefined;
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
  state.visible = visible;
  ui.libraryTitle.textContent = t("libraryTitle", { count: state.notes.length });
  ui.grid.replaceChildren(...visible.map(card));
  ui.noMatches.hidden = visible.length > 0;
  ui.sendAll.hidden = !visible.length;
  ui.sendAllLabel.textContent = t("sendCount", { count: visible.length });
  ui.aiHint.hidden = state.notes.length < 2;
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
      el("span", { className: "card-title" }, el("bdi", {}, note.title)),
      el("span", { className: "card-meta" }, details.filter(Boolean).join(" · ")),
      ...(badges.length ? [el("span", { className: "badges" }, ...badges)] : []),
    ),
  );
  button.dataset.id = String(note.id);
  button.addEventListener("click", () => void showNote(note));
  return el("li", {}, button);
}

function closeAll(): void {
  state.opening++;
  closeNote();
  for (const note of state.notes) if (note.thumbnail) URL.revokeObjectURL(note.thumbnail);
  state.notes = [];
  state.pack = undefined;
  ui.search.value = "";
  history.replaceState(null, "", location.pathname);
  show("home");
}

// ── Note ────────────────────────────────────────────────────────────────

async function showNote(note: LibraryNote, push = true): Promise<void> {
  const ticket = ++state.opening;
  let open: OpenNote;
  try {
    open = await openNote(note);
  } catch (error) {
    console.error(`Couldn't open ${note.title}`, error);
    toast(t("cantOpen", { name: note.file.name }), { error: true });
    return;
  }
  // A newer click or "Close all" happened while this note was opening.
  if (ticket !== state.opening) {
    open.close();
    return;
  }
  if (state.current) closeNote();
  else state.libraryScroll = window.scrollY;
  const observer = new IntersectionObserver(paintVisiblePages, { rootMargin: "1200px 0px" });
  state.current = { note, open, urls: [], fileUrls: new Map(), observer, rendered: new Set() };
  const empty = open.pageCount === 0;
  ui.noteTitle.replaceChildren(el("bdi", {}, note.title));
  ui.filesCount.textContent = note.attachments.length ? count(note.attachments.length) : "";
  ui.share.hidden = !state.canShare || empty;
  ui.pdf.hidden = empty;
  ui.copy.hidden = !note.text;
  renderMeta();
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

function renderMeta(): void {
  const { note } = state.current!;
  ui.noteMeta.textContent = [
    note.modifiedMs === null ? "" : t("edited", { date: formatDate(note.modifiedMs) }),
    t("pages", { count: note.pageCount }),
  ]
    .filter(Boolean)
    .join(" · ");
}

function renderPages(): void {
  const current = state.current!;
  if (!current.open.pageCount) {
    ui.panels.pages.replaceChildren(el("p", { className: "empty" }, t("noPages")));
    return;
  }
  const figures = Array.from({ length: current.open.pageCount }, (_, index) => {
    const figure = el("figure", { className: "page" }, el("img", { decoding: "async" }), el("figcaption"));
    figure.dataset.index = String(index);
    current.observer.observe(figure);
    return figure;
  });
  ui.panels.pages.replaceChildren(...figures);
  labelPages();
}

function labelPages(): void {
  const total = state.current?.open.pageCount ?? 0;
  ui.panels.pages.querySelectorAll<HTMLElement>(".page").forEach((figure, index) => {
    figure.querySelector("img")!.alt = t("pageAlt", { page: index + 1, count: total });
    figure.querySelector("figcaption")!.textContent = figure.classList.contains("failed")
      ? t("pageFailed")
      : `${count(index + 1)} / ${count(total)}`;
  });
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
      figure.querySelector("figcaption")!.textContent = t("pageFailed");
    }
  }
}

// The Text and Files tabs unpack images and recordings, so they are built only when first opened.
function renderPanel(tab: Tab): void {
  const current = state.current!;
  current.rendered.add(tab);
  const { note } = current;
  if (tab === "text") {
    ui.panels.text.replaceChildren(
      note.text ? renderNoteText(note.text, (name) => (imageType(name) ? attachmentUrl(name) : undefined)) : el("p", { className: "empty" }, t("noText")),
    );
  } else if (tab === "files") {
    ui.panels.files.replaceChildren(
      note.attachments.length ? el("ul", { className: "file-list" }, ...note.attachments.map(fileItem)) : el("p", { className: "empty" }, t("noFiles")),
    );
  }
}

function fileItem({ name, size }: Attachment): HTMLLIElement {
  const label = displayName(name);
  const meta = el("span", { className: "file-meta" }, el("span", { className: "file-name" }, el("bdi", {}, label)), el("span", { className: "file-size" }, formatSize(size)));
  const download = el("button", { className: "button small", type: "button" }, t("downloadFile"));
  download.setAttribute("aria-label", `${t("downloadFile")}: ${label}`);
  download.addEventListener("click", () => {
    const bytes = state.current?.open.attachment(name);
    if (bytes) downloadBlob(blobOf(bytes, mimeType(name)), label);
    else toast(t("failed"), { error: true });
  });
  const preview = imageType(name)
    ? el("img", { className: "file-preview", src: attachmentUrl(name) ?? "", alt: label, loading: "lazy" })
    : audioType(name)
      ? el("audio", { controls: true, preload: "none", src: attachmentUrl(name) ?? "" })
      : undefined;
  preview?.setAttribute("aria-label", label);
  return el("li", { className: "file" }, ...(preview ? [preview] : []), meta, el("span", { className: "file-actions" }, download));
}

function attachmentUrl(name: string): string | undefined {
  const current = state.current;
  if (!current) return undefined;
  const cached = current.fileUrls.get(name);
  if (cached) return cached;
  const bytes = current.open.attachment(name);
  if (!bytes) return undefined;
  const url = URL.createObjectURL(blobOf(bytes, mimeType(name)));
  current.fileUrls.set(name, url);
  return url;
}

function formatSize(bytes: number): string {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;
  const power = Math.min(units.length - 1, Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)));
  return new Intl.NumberFormat(language(), { style: "unit", unit: units[power], maximumFractionDigits: 1 }).format(bytes / 1024 ** power);
}

function selectTab(tab: Tab, focus = true): void {
  for (const [name, button] of Object.entries(ui.tabs) as [Tab, HTMLElement][]) {
    const selected = name === tab;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    ui.panels[name].hidden = !selected;
  }
  if (tab !== "pages" && !state.current?.rendered.has(tab)) renderPanel(tab);
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

// Texts that depend on the language, redrawn when it changes.
function refreshNote(): void {
  const current = state.current;
  if (!current) return;
  renderMeta();
  if (current.open.pageCount) labelPages();
  else renderPages();
  for (const tab of current.rendered) renderPanel(tab);
}

// ── Actions ─────────────────────────────────────────────────────────────

async function currentPdf(): Promise<Uint8Array> {
  const current = state.current!;
  current.pdf ??= await notePdf(current.note, (done, total) => progress(t("makingPdf", { done, count: total }), done === 1));
  return current.pdf;
}

async function sharePdf(): Promise<void> {
  const { note } = state.current!;
  const pdf = await currentPdf();
  hideToast();
  try {
    await navigator.share({ files: [new File([blobOf(pdf, "application/pdf")], `${noteFileName(note)}.pdf`, { type: "application/pdf" })], title: note.title });
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

// Phones share straight into the AI app; computers have no such menu, so the files land in Downloads.
async function sendToAi(notes: LibraryNote[]): Promise<void> {
  const key = notes.map(({ id }) => id).join();
  if (state.pack?.key !== key) {
    state.pack = undefined;
    state.pack = { key, ...(await buildAiPack(notes, (done, total) => progress(t("preparing", { done, count: total }), done === 1))) };
  }
  const { files, incomplete } = state.pack;
  if (sharesToApps() && navigator.canShare({ files })) {
    try {
      await navigator.share({ files });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        hideToast();
        return;
      }
      // Preparing took long enough for the browser to forget the tap; one more tap sends it.
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        toast(t("aiReady"), { action: { label: t("sendToAi"), run: () => void runAction(() => sendToAi(notes)) } });
        return;
      }
      throw error;
    }
    if (incomplete) toast(t("aiPartial"), { error: true });
    else hideToast();
    return;
  }
  files.forEach((file) => downloadBlob(file, file.name));
  // Browsers ask before a page saves several files at once; refusing would silently drop all but the first.
  const message = [t("aiSaved", { count: files.length }), ...(files.length > 1 ? [t("aiAllowDownloads")] : []), ...(incomplete ? [t("aiPartial")] : [])];
  toast(message.join(" "), { error: incomplete, persist: files.length > 1 });
}

const sharesToApps = (): boolean => state.canShare && matchMedia("(pointer: coarse)").matches;

async function downloadPdf(): Promise<void> {
  const { note } = state.current!;
  downloadBlob(blobOf(await currentPdf(), "application/pdf"), `${noteFileName(note)}.pdf`);
  hideToast();
}

async function copyText(): Promise<void> {
  const { note } = state.current!;
  await navigator.clipboard.writeText(`${note.title}\n\n${note.text}`);
  toast(t("copied"));
}

async function exportAll(): Promise<void> {
  const { blob, failed } = await exportZip(state.notes, (done, total) => progress(t("exporting", { done, count: total }), done === 1));
  const skipped = failed.length ? t("exportSkipped", { names: listed(failed, ", ") }) : "";
  if (failed.length === state.notes.length) {
    toast(skipped, { error: true });
    return;
  }
  downloadBlob(blob, `Notes export ${isoDate(Date.now())}.zip`);
  if (skipped) toast(skipped, { error: true });
  else toast(t("exported"));
}

// One long task at a time: a PDF or an export holds every page in memory, so two at once could exhaust a phone.
async function runAction(action: () => Promise<void>): Promise<void> {
  if (state.busy) return;
  const buttons = [ui.exportAll, ui.sendAll, ui.closeAll, ui.send, ui.pdf, ui.share];
  state.busy = true;
  buttons.forEach((button) => (button.disabled = true));
  try {
    await action();
  } catch (error) {
    console.error(error);
    toast(t("failed"), { error: true });
  } finally {
    state.busy = false;
    buttons.forEach((button) => (button.disabled = false));
  }
}

// ── Messages ────────────────────────────────────────────────────────────

let toastTimer: number | undefined;

// Screen readers hear messages through two always-present live regions; the toast itself is only visual.
function announce(message: string, urgent: boolean): void {
  const region = urgent ? ui.alert : ui.status;
  region.textContent = "";
  setTimeout(() => (region.textContent = message), 50);
}

function toast(message: string, options: { error?: boolean; persist?: boolean; action?: { label: string; run: () => void } } = {}): void {
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
  announce(message, Boolean(options.error));
  if (!options.error && !options.action && !options.persist) toastTimer = window.setTimeout(hideToast, TOAST_MS);
}

function progress(message: string, spoken: boolean): void {
  clearTimeout(toastTimer);
  ui.toastText.textContent = message;
  ui.toast.classList.remove("error");
  ui.toastAction.hidden = true;
  ui.toast.hidden = false;
  if (spoken) announce(message, false);
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
  byId("samples").addEventListener("click", () => {
    openSamples().catch((error: unknown) => {
      console.error(error);
      toast(t("failed"), { error: true });
    });
  });
  ui.fileInput.addEventListener("change", () => {
    const files = [...(ui.fileInput.files ?? [])];
    ui.fileInput.value = "";
    void addFiles(files);
  });
  ui.exportAll.addEventListener("click", () => void runAction(exportAll));
  ui.sendAll.addEventListener("click", () => void runAction(() => sendToAi(state.visible)));
  ui.send.addEventListener("click", () => void runAction(() => sendToAi([state.current!.note])));
  ui.closeAll.addEventListener("click", closeAll);
  byId("back").addEventListener("click", () => (history.state?.note ? history.back() : backToLibrary()));
  ui.share.addEventListener("click", () => void runAction(sharePdf));
  ui.pdf.addEventListener("click", () => void runAction(downloadPdf));
  ui.copy.addEventListener("click", () => {
    copyText().catch((error: unknown) => {
      console.error(error);
      toast(t("failed"), { error: true });
    });
  });
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
  ui.language.addEventListener("change", () => void changeLanguage(ui.language.value, true));

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

async function changeLanguage(code: string, remember: boolean): Promise<void> {
  try {
    await setLanguage(code, remember);
  } catch (error) {
    console.error(`Couldn't load the ${code} translation`, error);
    toast(t("failed"), { error: true });
    ui.language.value = language();
    return;
  }
  renderLibrary();
  refreshNote();
}

async function start(): Promise<void> {
  ui.language.replaceChildren(...LANGUAGES.map(([code, name]) => el("option", { value: code, lang: code }, name)));
  const code = preferredLanguage();
  ui.language.value = code;
  if (code !== "en") await changeLanguage(code, false);
  state.canShare = canShareFiles();
  wireEvents();
  if ("serviceWorker" in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register("./sw.js").catch((error: unknown) => console.error("Offline support is unavailable", error));
  }
  (window as Window & { launchQueue?: LaunchQueue }).launchQueue?.setConsumer(({ files }) => {
    Promise.all(files.map((handle) => handle.getFile())).then(addFiles, (error: unknown) => {
      console.error(error);
      toast(t("failed"), { error: true });
    });
  });
  const shared = await takeSharedFiles();
  if (shared?.length) await addFiles(shared);
  else if (shared) toast(t("nothingShared"), { error: true });
}

void start();

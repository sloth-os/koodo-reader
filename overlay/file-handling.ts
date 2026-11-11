// Web File Handling API integration for Koodo Reader (PWA build).
// Registered via manifest.json "file_handlers": the OS "Open with" lists
// Koodo for every supported format, and launchQueue hands us the files.
//
// importBookFunc is a no-op placeholder until the Manager page mounts its
// ImportLocal component (inside the Header). Readiness is detected by
// waiting for the store's importBookFunc reference to change away from the
// placeholder captured at boot; on a cold start into another route we
// navigate to the manager first so the importer mounts.

import { useAppStore } from "../../store/useAppStore";

declare var window: any;

const SUPPORTED_EXTENSIONS = [
  ".epub",
  ".pdf",
  ".txt",
  ".mobi",
  ".azw3",
  ".azw",
  ".kdz",
  ".htm",
  ".html",
  ".xml",
  ".xhtml",
  ".mhtml",
  ".docx",
  ".doc",
  ".rtf",
  ".md",
  ".fb2",
  ".chm",
  ".cbz",
  ".cbt",
  ".cbr",
  ".cb7",
  ".pptx",
  ".ppt",
  ".xps",
  ".oxps",
  ".djvu",
  ".djv",
  ".ofd",
  ".caj",
];

// Captured when this module initializes: the no-op placeholder installed by
// the store's initial state. ImportLocal replaces it with the real importer.
let placeholderImportFunc: unknown;

const getExtension = (name: string) => {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLowerCase() : "";
};

const isImporterReady = () =>
  useAppStore.getState().book.importBookFunc !== placeholderImportFunc;

const waitForImporter = async (timeoutMs = 15000) => {
  if (isImporterReady()) return true;
  // ImportLocal lives on the manager page: make sure we're on it so the
  // Header (and its ImportLocal) mounts.
  const hash = window.location.hash || "";
  if (!hash.startsWith("#/manager")) {
    window.location.hash = "#/manager/home";
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isImporterReady()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return isImporterReady();
};

const importFiles = async (files: File[]) => {
  if (!(await waitForImporter())) {
    console.error("[file-handling] importer never became ready");
    return;
  }
  const importBookFunc = useAppStore.getState().book.importBookFunc as (
    file: File
  ) => Promise<void>;
  for (const file of files) {
    if (!SUPPORTED_EXTENSIONS.includes(getExtension(file.name))) {
      continue;
    }
    await importBookFunc(file);
  }
};

const consumeLaunchQueue = async (launchParams: any) => {
  if (!launchParams || !launchParams.files || !launchParams.files.length) {
    return;
  }
  const files: File[] = [];
  for (const handle of launchParams.files) {
    try {
      const file = await handle.getFile();
      files.push(file);
    } catch (error) {
      console.error("[file-handling] failed to read launched file", error);
    }
  }
  if (!files.length) return;
  await importFiles(files);
};

export const initFileHandling = () => {
  placeholderImportFunc = useAppStore.getState().book.importBookFunc;
  // Expose a manual test hook so the import path can be exercised in
  // browsers/E2E without OS-level file association.
  window.__koodoFileHandlingTest = {
    importFiles,
    isImporterReady,
  };
  if (!("launchQueue" in window)) return;
  window.launchQueue.setConsumer(async (launchParams: any) => {
    try {
      await consumeLaunchQueue(launchParams);
    } catch (error) {
      console.error("[file-handling] launch failed", error);
    }
  });
};

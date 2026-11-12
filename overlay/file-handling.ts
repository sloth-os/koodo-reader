// Web File Handling API integration for Koodo Reader (PWA build).
// Registered via manifest.json "file_handlers": the OS "Open with" lists
// Koodo for every supported format, and launchQueue hands us the files.
//
// importBookFunc is a no-op placeholder until the Manager page mounts its
// ImportLocal component (inside the Header). Readiness requires BOTH the
// store reference to have moved off the boot placeholder AND the importer
// to be live in the DOM: a stale closure from an unmounted ImportLocal
// would otherwise pass the store-only check on warm launches.
//
// Window routing: the launch can land in any app window. Manager-route
// windows import locally; a reader popup (mid-book) must not be navigated
// away, so the files are relayed to a freshly opened library window via
// same-origin postMessage (File objects are structured-cloneable).

import toast from "react-hot-toast";
import i18next from "i18next";
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

const IMPORT_MESSAGE = "koodo-file-handling-import";
const IMPORT_ACK = "koodo-file-handling-import-ack";

// Captured when this module initializes: the no-op placeholder installed by
// the store's initial state. ImportLocal replaces it with the real importer.
let placeholderImportFunc: unknown;

const getExtension = (name: string) => {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLowerCase() : "";
};

const currentRoute = () => window.location.hash || "";

const isManagerRoute = () => {
  const hash = currentRoute();
  return (
    hash === "" ||
    hash === "#/" ||
    hash === "#/manager" ||
    hash.startsWith("#/manager/")
  );
};

// Reader popups are opened via window.open (opener set) and must not be
// navigated away mid-book; other non-manager windows (login, stats) can
// simply be redirected to the library by waitForImporter.
const isRelayRoute = () => !isManagerRoute() && !!window.opener;

const isImporterReady = () =>
  useAppStore.getState().book.importBookFunc !== placeholderImportFunc &&
  // Live-mount check: ImportLocal renders this root div on the manager page.
  !!document.querySelector(".import-from-local");

const waitForImporter = async (timeoutMs = 15000) => {
  if (isImporterReady()) return true;
  // ImportLocal lives on the manager page: make sure we're on it so the
  // Header (and its ImportLocal) mounts.
  if (!isManagerRoute()) {
    window.location.hash = "#/manager/home";
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isImporterReady()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return isImporterReady();
};

const importLocally = async (files: File[]) => {
  if (!(await waitForImporter())) {
    toast.error(i18next.t("Import failed"));
    console.error("[file-handling] importer never became ready");
    return;
  }
  const importBookFunc = useAppStore.getState().book.importBookFunc as (
    file: File
  ) => Promise<void>;
  for (const file of files) {
    if (!SUPPORTED_EXTENSIONS.includes(getExtension(file.name))) {
      toast.error(i18next.t("Unsupported file format") + ": " + file.name, {
        duration: 4000,
      });
      continue;
    }
    try {
      await importBookFunc(file);
    } catch (error) {
      toast.error(i18next.t("Import failed") + ": " + file.name, {
        duration: 4000,
      });
      console.error("[file-handling] import failed", error);
    }
  }
};

// Relay files from a non-manager window (reader popup) to a new library
// window. The opener retries until the new window's listener acks, so the
// message is never lost to load-order races. If the final retry and the ack
// cross paths the relay window may receive the files twice; its one-shot
// consume guard makes that harmless (and upstream dedupes identical books
// by MD5 regardless).
const relayToNewWindow = async (files: File[]): Promise<boolean> => {
  const target =
    new URL("./", window.location.href).href.split("#")[0] + "#/manager/home";
  let relay: any;
  try {
    relay = window.open(target, "_blank");
  } catch (error) {
    relay = null;
  }
  if (!relay) return false;
  return await new Promise<boolean>((resolve) => {
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      if (relay.closed) {
        // Relay window died (user closed it / it crashed): stop retrying
        // and let the caller fall back to importing in this window.
        window.clearInterval(timer);
        window.removeEventListener("message", onAck);
        resolve(false);
        return;
      }
      try {
        relay.postMessage(
          { type: IMPORT_MESSAGE, files },
          window.location.origin
        );
      } catch (error) {
        /* window still loading; retried below */
      }
      if (attempts >= 40) {
        window.clearInterval(timer);
        window.removeEventListener("message", onAck);
        resolve(false);
      }
    }, 500);
    const onAck = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== relay ||
        !event.data ||
        event.data.type !== IMPORT_ACK
      ) {
        return;
      }
      window.clearInterval(timer);
      window.removeEventListener("message", onAck);
      resolve(true);
    };
    window.addEventListener("message", onAck);
  });
};

const importFiles = async (files: File[]) => {
  if (!isRelayRoute()) {
    await importLocally(files);
    return;
  }
  const relayed = await relayToNewWindow(files);
  if (!relayed) {
    // Popup blocked or relay timed out: fall back to importing in this
    // window, which navigates it to the library.
    await importLocally(files);
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
      toast.error(i18next.t("Import failed"), { duration: 4000 });
      console.error("[file-handling] failed to read launched file", error);
    }
  }
  if (!files.length) return;
  await importFiles(files);
};

export const initFileHandling = () => {
  placeholderImportFunc = useAppStore.getState().book.importBookFunc;

  // Receiving side of the reader-popup relay. One-shot per window so the
  // opener's retry loop can't double-import if an ack races a resend.
  let relayConsumed = false;
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    if (!event.data || event.data.type !== IMPORT_MESSAGE) return;
    if (relayConsumed) return;
    relayConsumed = true;
    try {
      if (event.source) {
        (event.source as any).postMessage(
          { type: IMPORT_ACK },
          window.location.origin
        );
      }
    } catch (error) {
      /* opener vanished mid-relay; the files are still imported below */
    }
    const files = (event.data.files || []).filter(
      (file: any) => file instanceof File
    );
    if (files.length > 0) {
      void importLocally(files as File[]);
    }
  });

  // Manual test hook for local E2E (launchQueue needs OS-level file
  // association). Deliberately NOT exposed on the public deployment.
  if (
    ["localhost", "127.0.0.1", "[::1]"].indexOf(window.location.hostname) >= 0
  ) {
    window.__koodoFileHandlingTest = {
      importFiles,
      isImporterReady,
    };
  }

  if (!("launchQueue" in window)) return;
  window.launchQueue.setConsumer(async (launchParams: any) => {
    try {
      await consumeLaunchQueue(launchParams);
    } catch (error) {
      toast.error(i18next.t("Import failed"));
      console.error("[file-handling] launch failed", error);
    }
  });
};

/* Zotero bootstrap entry: load modules and register/unregister them. */
var FetchSI;
var LinkedCleanup;
var Dedupe;

function install() {}

async function startup({ id, version, rootURI }) {
  Services.scriptloader.loadSubScript(rootURI + "fetchsi.js");
  Services.scriptloader.loadSubScript(rootURI + "linkedcleanup.js");
  Services.scriptloader.loadSubScript(rootURI + "dedupe.js");
  FetchSI.init({ id, version, rootURI });
  LinkedCleanup.init();
  Dedupe.init();
}

function shutdown() {
  if (Dedupe) Dedupe.shutdown();
  if (LinkedCleanup) LinkedCleanup.shutdown();
  if (FetchSI) FetchSI.shutdown();
  Dedupe = undefined;
  LinkedCleanup = undefined;
  FetchSI = undefined;
}

function uninstall() {}

/*
 * Duplicate guard — when a new file is attached to an item that already has a
 * byte-identical file (same PDF dragged in twice, Sidecar fetching an SI you had
 * already added by hand, …), the new attachment is removed again, so no
 * "<name> 2.pdf" copy is left behind.
 *
 * Rules:
 *  - only new child file attachments; the older attachment (with its
 *    annotations) is always the one kept
 *  - identical = same size AND same bytes (no fuzzy matching: a different
 *    version of the same paper is kept)
 *  - waits until the file has settled (download done, Attanger rename/move done)
 *  - ignored while Zotero sync is running (items from other computers)
 *  - switch off: extensions.zotero.fetchsi.skipDuplicates = false
 */
Dedupe = {
  observerID: null,
  enabled: false,

  init() {
    this.observerID = Zotero.Notifier.registerObserver(
      {
        notify: (event, type, ids) => {
          if (event !== "add" || !this.enabled || !this.isOn()) return;
          if (this.syncing()) return;
          for (const id of ids) {
            this.check(id).catch((e) => Zotero.logError(e));
          }
        },
      },
      ["item"],
      "sidecar-dedupe"
    );
    this.enabled = true;
  },

  shutdown() {
    this.enabled = false;
    if (this.observerID) Zotero.Notifier.unregisterObserver(this.observerID);
    this.observerID = null;
  },

  isOn() {
    return Zotero.Prefs.get("fetchsi.skipDuplicates") !== false;
  },

  syncing() {
    try {
      return !!Zotero.Sync.Runner.syncInProgress;
    } catch (e) {
      return false;
    }
  },

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  /** Wait until the attachment's file exists and path + size stop changing. */
  async settledPath(item) {
    let last = null;
    for (let i = 0; i < 20; i++) {
      await this.sleep(1500);
      if (!this.enabled || item.deleted || !Zotero.Items.get(item.id)) return null;
      const path = await item.getFilePathAsync();
      const size = path ? (await IOUtils.stat(path)).size : -1;
      const now = `${path}|${size}`;
      if (path && size > 0 && now === last) return path;
      last = now;
    }
    return null;
  },

  async check(id) {
    const item = Zotero.Items.get(id);
    if (!item || !item.isFileAttachment() || !item.parentItem) return;
    const path = await this.settledPath(item);
    if (!path) return;
    if (item.getAnnotations().length > 0) return; // already in use, leave alone

    const size = (await IOUtils.stat(path)).size;
    let bytes = null;
    for (const sib of Zotero.Items.get(item.parentItem.getAttachments())) {
      if (sib.id === item.id || !sib.isFileAttachment()) continue;
      // keep the older one (same second → lower ID counts as older)
      if (sib.dateAdded > item.dateAdded || (sib.dateAdded === item.dateAdded && sib.id > item.id)) continue;
      let same = false;
      try {
        // a sibling may be mid-move by Attanger; skip it instead of aborting the check
        const p = await sib.getFilePathAsync();
        if (!p || p === path) continue;
        if ((await IOUtils.stat(p)).size !== size) continue;
        bytes = bytes || (await IOUtils.read(path));
        same = this.sameBytes(bytes, await IOUtils.read(p));
      } catch (e) {
        Zotero.debug(`Sidecar dedupe: could not read sibling ${sib.key}: ${e.message}`);
      }
      if (!same) continue;

      const name = PathUtils.filename(path);
      Zotero.debug(`Sidecar dedupe: ${name} is identical to attachment ${sib.key}; removed`);
      await item.eraseTx(); // linked file → macOS Trash via LinkedCleanup
      this.notify(name, sib.getField("title"));
      return;
    }
  },

  sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  },

  notify(name, keptTitle) {
    const zh = (Zotero.locale || "en").startsWith("zh");
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("Sidecar");
    pw.addDescription(
      zh
        ? `重复文件已跳过（和"${keptTitle}"完全相同）：${name}`
        : `Duplicate skipped (identical to "${keptTitle}"): ${name}`
    );
    pw.show();
    pw.startCloseTimer(6000);
  },
};

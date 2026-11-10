/*
 * Linked-file cleanup — when a linked-file attachment is permanently deleted in
 * Zotero (Empty Trash / Delete Permanently), move its file to the macOS Trash.
 *
 * Zotero never touches linked files on erase. We wrap Item._eraseData to record
 * the file path in the 'delete' notifier data; the notifier fires only after the
 * DB transaction commits, so a rolled-back erase never removes a file.
 *
 * Safety rules:
 *  - linked-file attachments only (stored files are already handled by Zotero)
 *  - only files inside Attanger's destination folder (zoteroattanger.destDir)
 *  - skipped if another attachment still links the same path
 *  - files go to the macOS Trash via /usr/bin/trash (recoverable), never rm
 *  - switch off: extensions.zotero.fetchsi.trashLinkedFiles = false
 */
LinkedCleanup = {
  origEraseData: null,
  wrapper: null,
  observerID: null,
  enabled: false,

  init() {
    if (!Zotero.isMac) return;
    const self = this;
    const proto = Zotero.Item.prototype;
    const orig = proto._eraseData;
    this.origEraseData = orig;
    this.wrapper = async function (env) {
      if (self.enabled) {
        try {
          if (
            this.isAttachment() &&
            this.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_FILE &&
            env.notifierData &&
            env.notifierData[this.id]
          ) {
            const path = this.getFilePath();
            if (path) {
              env.notifierData[this.id].fetchSILinkedFile = {
                path,
                raw: this.attachmentPath,
              };
            }
          }
        } catch (e) {
          Zotero.logError(e);
        }
      }
      return orig.call(this, env);
    };
    proto._eraseData = this.wrapper;

    this.observerID = Zotero.Notifier.registerObserver(
      {
        notify: (event, type, ids, extraData) => {
          if (event !== "delete" || !self.enabled) return;
          self.onDelete(ids, extraData).catch((e) => Zotero.logError(e));
        },
      },
      ["item"],
      "fetchSI-linkedCleanup"
    );
    this.enabled = true;
  },

  shutdown() {
    this.enabled = false;
    if (this.observerID) Zotero.Notifier.unregisterObserver(this.observerID);
    this.observerID = null;
    // Restore only if nobody wrapped on top of us; otherwise our wrapper stays
    // in the chain but is inert (enabled = false).
    if (this.wrapper && Zotero.Item.prototype._eraseData === this.wrapper) {
      Zotero.Item.prototype._eraseData = this.origEraseData;
    }
  },

  isOn() {
    return Zotero.Prefs.get("fetchsi.trashLinkedFiles") !== false;
  },

  /** Attanger destination folder, without trailing slash; null if not set. */
  root() {
    const dir = Zotero.Prefs.get("extensions.zotero.zoteroattanger.destDir", true);
    if (!dir) return null;
    return PathUtils.normalize(dir).replace(/\/+$/, "");
  },

  async onDelete(ids, extraData) {
    if (!this.isOn()) return;
    const root = this.root();
    if (!root) return;
    for (const id of ids) {
      const info = extraData && extraData[id] && extraData[id].fetchSILinkedFile;
      if (!info) continue;
      const path = PathUtils.normalize(info.path);
      if (!path.startsWith(root + "/")) {
        Zotero.debug(`Fetch SI cleanup: outside ${root}, kept: ${path}`);
        continue;
      }
      const stillLinked = await Zotero.DB.valueQueryAsync(
        "SELECT COUNT(*) FROM itemAttachments WHERE path=?",
        [info.raw]
      );
      if (stillLinked > 0) {
        Zotero.debug(`Fetch SI cleanup: still linked elsewhere, kept: ${path}`);
        continue;
      }
      if (!(await IOUtils.exists(path))) continue;
      try {
        await Zotero.Utilities.Internal.exec("/usr/bin/trash", [path]);
        Zotero.debug(`Fetch SI cleanup: moved to Trash: ${path}`);
        await this.removeEmptyDirs(PathUtils.parent(path), root);
      } catch (e) {
        Zotero.logError(e);
      }
    }
  },

  /**
   * Remove folders left empty (only .DS_Store) after the file is gone, walking
   * up year/journal/author levels but never the root itself.
   */
  async removeEmptyDirs(dir, root) {
    while (dir && dir !== root && dir.startsWith(root + "/")) {
      const children = await IOUtils.getChildren(dir);
      const real = children.filter((c) => PathUtils.filename(c) !== ".DS_Store");
      if (real.length > 0) return;
      await IOUtils.remove(dir, { recursive: true });
      Zotero.debug(`Fetch SI cleanup: removed empty folder: ${dir}`);
      dir = PathUtils.parent(dir);
    }
  },
};

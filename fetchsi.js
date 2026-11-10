/*
 * Sidecar — download Supplementary Information / Peer Review File PDFs
 * as child attachments.
 *
 * Nature (10.1038): article pages are static HTML; each SI file is an
 *   <a data-test="supp-info-link" href="https://static-content.springer.com/esm/...">
 * so one GET of the article page is enough.
 *
 * Science (10.1126) / PNAS (10.1073): both Atypon sites behind Cloudflare, so a plain
 * GET returns 403. The article page is loaded in Zotero's hidden browser (real Gecko,
 * runs the Cloudflare JS check); if a human click is needed, a visible Zotero window
 * opens once. SI links are <a href="/doi/suppl/<DOI>/suppl_file/<name>.pdf">. The PDFs
 * then go through importFromURL, whose 403 fallback (Zotero.BrowserRequest) fetches
 * them in a hidden browser with the same cookies, after we register both hosts.
 */
var { HiddenBrowser } = ChromeUtils.importESModule("chrome://zotero/content/HiddenBrowser.mjs");

FetchSI = {
  pluginID: null,
  menuID: null,

  // PDF labels that are not worth saving
  SKIP_LABELS: [
    /reporting summary/i,
    /description of additional supplementary/i,
    /mdar|reproducibility[ _-]?checklist/i, // Science
    /article plus supplemental/i, // Cell: main text + SI merged into one PDF
  ],
  PEER_REVIEW: /peer review/i,

  // DOI prefix → publisher. "browser" = page needs the hidden browser (Cloudflare).
  PUBLISHERS: {
    "10.1038": { name: "Nature", browser: false, page: (doi, sfx) => `https://www.nature.com/articles/${sfx}`, pdf: (doi, sfx) => `https://www.nature.com/articles/${sfx}.pdf` },
    "10.1126": { name: "Science", browser: true, host: "www.science.org", match: "://www.science.org", supplPage: true, page: (doi) => `https://www.science.org/doi/${doi}`, pdf: (doi) => `https://www.science.org/doi/pdf/${doi}?download=true` },
    "10.1073": { name: "PNAS", browser: true, host: "www.pnas.org", match: "://www.pnas.org", supplPage: true, page: (doi) => `https://www.pnas.org/doi/${doi}`, pdf: (doi) => `https://www.pnas.org/doi/pdf/${doi}?download=true` },
    // Wiley Online Library (AGU journals live on agupubs.onlinelibrary.wiley.com;
    // other Wiley journals may redirect to a society subdomain, e.g. rmets.)
    "10.1029": { name: "AGU", browser: true, host: "agupubs.onlinelibrary.wiley.com", match: "onlinelibrary.wiley.com", page: (doi) => `https://agupubs.onlinelibrary.wiley.com/doi/${doi}`, pdf: (doi) => `https://agupubs.onlinelibrary.wiley.com/doi/pdfdirect/${doi}?download=true` },
    "10.1111": { name: "Wiley", browser: true, host: "onlinelibrary.wiley.com", match: "onlinelibrary.wiley.com", page: (doi) => `https://onlinelibrary.wiley.com/doi/${doi}`, pdf: (doi) => `https://onlinelibrary.wiley.com/doi/pdfdirect/${doi}?download=true` },
    "10.1016": {
      name: "Cell",
      browser: true,
      host: "www.cell.com",
      match: "://www.cell.com",
      accept: (sfx) => FetchSI.cellCode(sfx) !== null,
      resolve: (doi, sfx) => FetchSI.resolveCell(doi, sfx),
    },
    "10.1002": { name: "Wiley", browser: true, host: "onlinelibrary.wiley.com", match: "onlinelibrary.wiley.com", page: (doi) => `https://onlinelibrary.wiley.com/doi/${doi}`, pdf: (doi) => `https://onlinelibrary.wiley.com/doi/pdfdirect/${doi}?download=true` },
  },
  PLAIN_UA_HOSTS: ["www.science.org", "www.pnas.org", "onlinelibrary.wiley.com", "agupubs.onlinelibrary.wiley.com", "www.cell.com"],

  // Cell Press (www.cell.com) shares the Elsevier prefix 10.1016, so only these
  // journal codes (DOI "10.1016/j.<code>.…") are handled; code → cell.com path.
  CELL_JOURNALS: {
    cell: "cell", oneear: "one-earth", isci: "iscience", crsus: "cell-reports-sustainability",
    cub: "current-biology", tree: "trends/ecology-evolution", tplants: "trends/plant-science",
    joule: "joule", celrep: "cell-reports", xcrp: "cell-reports-physical-science",
    xinn: "the-innovation", heliyon: "heliyon", ynexs: "nexus", chempr: "chem", matt: "matter",
  },

  // Cloudflare interstitial / Turnstile widget
  CF_LOCATOR:
    '#challenge-form, #challenge-stage, #challenge-running, #cf-challenge-running, .cf-turnstile, #turnstile-wrapper, iframe[src*="challenges.cloudflare.com"]',

  // UI strings: Chinese when Zotero runs in Chinese, English otherwise
  T: {
    en: {
      menu: "Fetch supplements & peer review",
      checking: (n) => `Checking ${n} item(s)…`,
      none: "no SI PDF on page",
      result: (a, e) => `SI +${a} new, ${e} already attached`,
      main_added: "main PDF added",
      main_failed: "main PDF not available (no access?)",
      failed: "FAILED",
      natureOnly: " (Nature / Science / PNAS / AGU / Wiley / Cell only)",
      cfFailed: "Cloudflare check not passed; open the article once in Zotero and retry",
      roleMenu: "Sidecar: set file type",
      role_Main: "Main article",
      role_SI: "Supplement (SI)",
      role_PeerReview: "Peer review",
      role_Other: "Other",
      confirmMain: (n, r) =>
        `${n} selected attachment(s) look like the main article ("Full Text PDF" or the oldest PDF).\nSet as "${r}" anyway?`,
    },
    zh: {
      menu: "获取补充材料与评审意见",
      checking: (n) => `正在检查 ${n} 篇文章…`,
      none: "页面上没有 SI PDF",
      result: (a, e) => `SI 新增 ${a} 个，已有 ${e} 个`,
      main_added: "正文已下载",
      main_failed: "正文下载失败（可能无权限）",
      failed: "失败",
      natureOnly: "（仅支持 Nature / Science / PNAS / AGU / Wiley / Cell）",
      cfFailed: "未通过 Cloudflare 验证，请稍后重试",
      roleMenu: "Sidecar：设定文件类型",
      role_Main: "正文",
      role_SI: "补充材料（SI）",
      role_PeerReview: "评审意见",
      role_Other: "其他",
      confirmMain: (n, r) =>
        `选中的附件里有 ${n} 个看起来是正文（标题是"Full Text PDF"或最早加入的 PDF）。\n确定要设为"${r}"吗？`,
    },
  },

  t(key, ...args) {
    const lang = (Zotero.locale || "en").startsWith("zh") ? "zh" : "en";
    const v = this.T[lang][key];
    return typeof v === "function" ? v(...args) : v;
  },

  init({ id, rootURI }) {
    this.pluginID = id;
    this.registerChallengeHosts();
    this.menuID = Zotero.MenuManager.registerMenu({
      menuID: "fetch-si-item-menu",
      pluginID: id,
      target: "main/library/item",
      menus: [
        {
          menuType: "menuitem",
          icon: rootURI + "icons/menu.svg",
          onShowing: (event, context) => {
            const items = context.items || [];
            const any = items.some((it) => it.isRegularItem());
            const ok = items.some((it) => this.source(it));
            context.setVisible(any);
            context.setEnabled(ok);
            context.menuElem.setAttribute("label", this.t("menu") + (ok ? "" : this.t("natureOnly")));
          },
          onCommand: (event, context) => {
            this.run(context.items || []);
          },
        },
        {
          menuType: "submenu",
          icon: rootURI + "icons/menu.svg",
          onShowing: (event, context) => {
            context.menuElem.setAttribute("label", this.t("roleMenu"));
            context.setVisible(this.markable(context.items));
          },
          menus: this.ROLES.map((role) => ({
            menuType: "menuitem",
            onShowing: (event, context) => {
              context.menuElem.setAttribute("label", this.t("role_" + role));
            },
            onCommand: (event, context) => {
              this.mark(context.items || [], role).catch((e) => Zotero.logError(e));
            },
          })),
        },
      ],
    });
  },

  /** Selection is only child file attachments (e.g. an SI dragged in by hand). */
  markable(items) {
    return (
      !!items &&
      items.length > 0 &&
      items.every((it) => it.isFileAttachment() && it.parentItem)
    );
  },

  ROLES: ["Main", "SI", "PeerReview", "Other"],
  ROLE_TITLE: { Main: "Full Text PDF", SI: "SI", PeerReview: "Peer Review File", Other: "Other" },

  /**
   * Give attachments a role. File name = Zotero filename template of the parent,
   * prefixed for non-main roles: "SI_<name>", "SI_2_<name>", "PeerReview_<name>",
   * "Other_<name>". Attanger's skip-rename rule ^(SI|PeerReview|Other)_ keeps them.
   */
  async mark(items, role) {
    const targets = items.filter((it) => it.isFileAttachment() && it.parentItem);
    if (role !== "Main") {
      // Guard: the main article is usually "Full Text PDF"/"PDF" or the oldest PDF
      const looksMain = targets.filter((att) => {
        if (/^(full text pdf|pdf|full text)$/i.test(att.getField("title"))) return true;
        const pdfs = Zotero.Items.get(att.parentItem.getAttachments())
          .filter((a) => a.isPDFAttachment())
          .sort((a, b) => (a.dateAdded < b.dateAdded ? -1 : 1));
        return pdfs.length > 1 && pdfs[0].id === att.id;
      });
      if (
        looksMain.length &&
        !Services.prompt.confirm(
          Zotero.getMainWindow(),
          "Sidecar",
          this.t("confirmMain", looksMain.length, this.t("role_" + role))
        )
      ) {
        return;
      }
    }
    for (const att of targets) {
      const path = await att.getFilePathAsync();
      if (!path) continue;
      const parent = att.parentItem;
      const ext = (PathUtils.filename(path).match(/\.[^.]+$/) || [""])[0];
      const name = Zotero.Attachments.getFileBaseNameFromItem(parent);
      let prefix = role === "Main" ? "" : role + "_";
      if (role === "SI" || role === "Other") {
        // number further files of the same role: SI_, SI_2_, SI_3_ …
        const re = new RegExp(`^${role}(_\\d+)?_`);
        let used = 0;
        for (const s of Zotero.Items.get(parent.getAttachments())) {
          if (s.id === att.id || !s.isFileAttachment()) continue;
          const p = await s.getFilePathAsync();
          if (p && re.test(PathUtils.filename(p))) used += 1;
        }
        if (used > 0) prefix = `${role}_${used + 1}_`;
      }
      await att.renameAttachmentFile(`${prefix}${name}${ext}`, { unique: true });
      att.setField("title", this.ROLE_TITLE[role]);
      await att.saveTx();
    }
  },

  shutdown() {
    if (this.menuID) Zotero.MenuManager.unregisterMenu(this.menuID);
    this.menuID = null;
    const BR = Zotero.BrowserRequest;
    if (BR && this._entries) {
      BR.CHALLENGE_URLS = BR.CHALLENGE_URLS.filter((e) => !this._entries.includes(e));
    }
    this._entries = null;
  },

  /**
   * Tell Zotero's BrowserRequest that Science/PNAS are Cloudflare-guarded, so
   * importFromURL retries a 403 PDF in a hidden browser (and, if a click is needed,
   * a visible viewer), always with a plain Firefox UA that Cloudflare accepts.
   */
  registerChallengeHosts() {
    const BR = Zotero.BrowserRequest;
    if (!BR) return;
    this._entries = [];
    for (const pub of Object.values(this.PUBLISHERS)) {
      if (!pub.match || BR.CHALLENGE_URLS.some((e) => e.match === pub.match)) continue;
      const entry = { match: pub.match, captchaLocator: this.CF_LOCATOR };
      BR.CHALLENGE_URLS.push(entry);
      this._entries.push(entry);
    }
    for (const host of this.PLAIN_UA_HOSTS) {
      try {
        Zotero.VersionHeader.registerPlainUAHost(host);
      } catch (e) {
        Zotero.logError(e);
      }
    }
  },

  /** Item DOI (cleaned), from the DOI field or "DOI: …" in Extra. */
  itemDOI(item) {
    let doi = "";
    try {
      doi = item.getField("DOI") || "";
    } catch (e) {
      // item type without a DOI field (e.g. some report types)
    }
    if (!doi) {
      const m = (item.getField("extra") || "").match(/^DOI:\s*(\S+)/im);
      if (m) doi = m[1];
    }
    return Zotero.Utilities.cleanDOI(doi) || "";
  },

  /** {pub, doi, suffix} for a supported item, else null. */
  source(item) {
    if (!item || !item.isRegularItem()) return null;
    const doi = this.itemDOI(item);
    const m = doi.match(/^(10\.\d+)\/(.+)$/);
    if (m && this.PUBLISHERS[m[1]]) {
      const pub = this.PUBLISHERS[m[1]];
      if (pub.browser && !Zotero.BrowserRequest) return null; // Zotero too old
      if (pub.accept && !pub.accept(m[2])) return null;
      return { pub, doi, suffix: m[2] };
    }
    const u = (item.getField("url") || "").match(/nature\.com\/articles\/([^?#/]+)/i);
    if (u) return { pub: this.PUBLISHERS["10.1038"], doi: "10.1038/" + u[1], suffix: u[1] };
    return null;
  },

  // item IDs being fetched right now (a second click while waiting must not
  // start a parallel download of the same files)
  busy: new Set(),

  async run(items) {
    const targets = items.filter((it) => this.source(it) && !this.busy.has(it.id));
    if (!targets.length) return;
    for (const it of targets) this.busy.add(it.id);
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("Sidecar");
    pw.addDescription(this.t("checking", targets.length));
    pw.show();

    const lines = [];
    for (const item of targets) {
      const tag = this.baseName(item);
      try {
        const r = await this.fetchForItem(item);
        const parts = [r.found ? this.t("result", r.added, r.existing) : this.t("none")];
        if (r.main) parts.push(this.t("main_" + r.main)); // nothing shown when main already there
        lines.push(`${tag}: ${parts.join("；")}`);
      } catch (e) {
        Zotero.logError(e);
        lines.push(`${tag}: ${this.t("failed")} (${e.message || e})`);
      }
    }
    for (const it of targets) this.busy.delete(it.id);
    for (const l of lines) pw.addDescription(l);
    pw.startCloseTimer(10000);
  },

  async fetchForItem(item) {
    const { pub, doi, suffix } = this.source(item);
    const urls = pub.resolve
      ? await pub.resolve(doi, suffix)
      : { page: pub.page(doi, suffix), pdf: pub.pdf ? pub.pdf(doi, suffix) : null };
    const pageURL = urls.page;
    let files;
    if (pub.browser) {
      files = this.parseAtypon(await this.loadViaBrowser(pageURL), pageURL);
      if (!files.length && pub.supplPage) {
        // Older layouts list SI only on the separate supplement page
        const suppURL = `https://${pub.host}/doi/suppl/${doi}`;
        files = this.parseAtypon(await this.loadViaBrowser(suppURL), suppURL);
      }
    } else {
      const xhr = await Zotero.HTTP.request("GET", pageURL, {
        responseType: "document",
        timeout: 30000,
      });
      files = this.parseSupp(xhr.response, pageURL);
    }

    // Already there = same URL, or a file of the same role (SI_, SI_2_, PeerReview_)
    // added by hand or by "set file type". Nature PDFs differ byte-wise between
    // downloads, so the URL/role check is what prevents "…_1.pdf" copies.
    const atts = Zotero.Items.get(item.getAttachments());
    const existingURLs = new Set(atts.map((a) => a.getField("url")));
    const names = [];
    for (const a of atts) {
      if (!a.isFileAttachment()) continue;
      const p = await a.getFilePathAsync();
      if (p) names.push(PathUtils.filename(p));
    }
    const hasRole = (prefix) => names.some((n) => n.startsWith(prefix + "_"));

    let siIndex = 0;
    let added = 0;
    let existing = 0;
    for (const f of files) {
      const isPR = this.PEER_REVIEW.test(f.label);
      if (!isPR) siIndex += 1;
      const role = isPR ? "PeerReview" : siIndex > 1 ? `SI_${siIndex}` : "SI";
      if (existingURLs.has(f.url) || hasRole(role)) {
        existing += 1;
        continue;
      }
      // Bare prefix only ("SI", "SI_2", "PeerReview"). Zotero Attanger renames new
      // attachments with the library template; its rule
      //   filenameAsPrefixRules = ^(SI|PeerReview)(_\d+)?$
      // keeps this name as a prefix → "SI_<Author_Year_Title>.pdf".
      const fileBaseName = role;
      await Zotero.Attachments.importFromURL({
        libraryID: item.libraryID,
        parentItemID: item.id,
        url: f.url,
        title: isPR ? "Peer Review File" : `SI – ${f.label}`,
        fileBaseName,
        contentType: "application/pdf",
        referrer: pageURL,
      });
      added += 1;
    }
    const main = await this.fetchMain(item, doi, urls.pdf, pageURL, atts);
    return { found: files.length, added, existing, main };
  },

  /** Extract SI PDF links (label + absolute URL) from a Nature article page. */
  parseSupp(doc, pageURL) {
    const seen = new Set();
    const out = [];
    for (const a of doc.querySelectorAll('a[data-test="supp-info-link"]')) {
      const href = a.getAttribute("href");
      if (!href) continue;
      const url = new URL(href, pageURL).href;
      if (!/\.pdf$/i.test(new URL(url).pathname)) continue;
      const label = a.textContent.replace(/\(download.*$/is, "").replace(/\s+/g, " ").trim();
      if (this.SKIP_LABELS.some((re) => re.test(label))) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ url, label });
    }
    return out;
  },

  /**
   * Main article PDF, only if the item has none. A PDF counts as main unless it
   * carries a supplement role (file prefix SI_/PeerReview_/Other_, or title SI…/
   * Peer Review…). Returns "added" | "failed" | null (already there / switched off).
   * Turn off: extensions.zotero.fetchsi.fetchMain = false
   */
  async fetchMain(item, doi, pdfURL, pageURL, atts) {
    if (!pdfURL || Zotero.Prefs.get("fetchsi.fetchMain") === false) return null;
    const rolePrefix = /^(SI|PeerReview|Other)(_\d+)?_/;
    for (const a of atts) {
      if (!a.isPDFAttachment()) continue;
      const p = await a.getFilePathAsync();
      const name = p ? PathUtils.filename(p) : "";
      const title = a.getField("title") || "";
      if (rolePrefix.test(name) || /^(SI\b|peer review|other$)/i.test(title)) continue;
      return null; // main PDF already attached
    }
    try {
      await Zotero.Attachments.importFromURL({
        libraryID: item.libraryID,
        parentItemID: item.id,
        url: pdfURL,
        title: "Full Text PDF",
        contentType: "application/pdf", // non-PDF (paywall page) is rejected
        referrer: pageURL,
      });
      return "added";
    } catch (e) {
      Zotero.debug(`Sidecar: main PDF failed for ${doi}: ${e.message || e}`);
      return "failed";
    }
  },

  /** "oneear" for "j.oneear.2022.05.010" if it is a Cell Press journal, else null. */
  cellCode(sfx) {
    const m = (sfx || "").match(/^j\.([a-z]+)\./i);
    return m && this.CELL_JOURNALS[m[1].toLowerCase()] ? m[1].toLowerCase() : null;
  },

  /**
   * cell.com URLs need the PII ("S2590-3322(22)00265-2"); doi.org sends Cell DOIs
   * to ScienceDirect instead. Crossref lists the PII as alternative-id.
   */
  async resolveCell(doi, sfx) {
    const xhr = await Zotero.HTTP.request("GET", `https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      responseType: "json",
      timeout: 20000,
    });
    const ids = xhr.response?.message?.["alternative-id"] || [];
    const raw = ids.map((x) => x.replace(/[^0-9A-Za-z]/g, "")).find((x) => /^S\d{15}[\dX]$/i.test(x));
    if (!raw) throw new Error("PII not found");
    const pii = `${raw.slice(0, 5)}-${raw.slice(5, 9)}(${raw.slice(9, 11)})${raw.slice(11, 16)}-${raw.slice(16)}`;
    const path = this.CELL_JOURNALS[this.cellCode(sfx)];
    return {
      page: `https://www.cell.com/${path}/fulltext/${pii}`,
      pdf: `https://www.cell.com/action/showPdf?pii=${pii}`,
    };
  },

  /** Is this document a Cloudflare interstitial rather than the real page? */
  isChallenge(doc) {
    return !!doc.querySelector(this.CF_LOCATOR) || /^just a moment/i.test(doc.title || "");
  },

  SUPP_SELECTOR:
    'a[href*="/doi/suppl/"], a[href*="/suppl_file/"], a[href*="downloadSupplement"], a[href*="/attachment/"][href*="mmc"]',

  /**
   * Get the DOM of a Cloudflare-guarded page, fastest route first:
   * 1. Plain HTTP GET: works once Zotero holds a valid cf_clearance cookie
   *    (both hosts get the plain Firefox UA the cookie is bound to).
   * 2. Hidden browser, polled every 0.5 s; returns as soon as the real page
   *    with SI links is there (no fixed "settle" wait).
   * 3. If the Cloudflare check is still up after ~15 s, open a visible Zotero
   *    window for one click, then retry.
   */
  async loadViaBrowser(url) {
    const t0 = Date.now();
    const log = (m) => Zotero.debug(`Sidecar: ${m} (${((Date.now() - t0) / 1000).toFixed(1)} s) ${url}`);
    try {
      const xhr = await Zotero.HTTP.request("GET", url, { responseType: "document", timeout: 20000 });
      if (!this.isChallenge(xhr.response)) {
        log("HTTP ok");
        return xhr.response;
      }
    } catch (e) {
      log(`HTTP ${e.status || e.message}, using hidden browser`);
    }

    const BR = Zotero.BrowserRequest;
    const customUserAgent = Zotero.VersionHeader.getPlainFirefoxUA();
    const site = (h) => (h || "").split(".").slice(-2).join(".");
    const host = site(new URL(url).host);
    for (let attempt = 0; attempt < 2; attempt++) {
      let hb;
      let challenged = false;
      try {
        hb = new HiddenBrowser({ customUserAgent });
        await hb._createdPromise;
        hb.load(url).catch(() => {}); // don't wait for full load; poll instead
        let realSince = null;
        for (let i = 0; i < 60; i++) {
          await Zotero.Promise.delay(500);
          let doc;
          try {
            if (site(hb.currentURI?.host) !== host) continue;
            doc = await hb.getDocument();
          } catch (e) {
            continue;
          }
          if (this.isChallenge(doc)) {
            challenged = true;
            realSince = null;
            if (i >= 30) break; // ~15 s on the challenge → ask the user
            continue;
          }
          if (doc.querySelector(this.SUPP_SELECTOR)) {
            log("browser ok");
            return doc;
          }
          // Real page but no SI link yet: allow 3 s for late rendering
          realSince ??= Date.now();
          if (doc.body && Date.now() - realSince > 3000) {
            log("browser ok, no SI links");
            return doc;
          }
        }
      } finally {
        if (hb) hb.destroy();
      }
      if (attempt === 0 && challenged) {
        log("asking user to clear Cloudflare");
        await BR.clearChallengeInViewer(url, { customUserAgent, captchaLocator: this.CF_LOCATOR });
      } else break;
    }
    throw new Error(this.t("cfFailed"));
  },

  /**
   * SI PDF links on an Atypon page.
   *   Science, PNAS: /doi/suppl/<DOI>/suppl_file/<name>.pdf
   *   Wiley / AGU:   /action/downloadSupplement?doi=<DOI>&file=<name>-sup-0001-….pdf
   */
  parseAtypon(doc, pageURL) {
    const seen = new Set();
    const out = [];
    for (const a of doc.querySelectorAll(this.SUPP_SELECTOR)) {
      const href = a.getAttribute("href");
      if (!href) continue;
      const u = new URL(href, pageURL);
      u.hash = "";
      let file;
      if (/downloadSupplement/i.test(u.pathname)) {
        file = u.searchParams.get("file") || ""; // query is needed to identify the file
      } else {
        u.search = "";
        file = decodeURIComponent(u.pathname.split("/").pop());
      }
      if (!/\.pdf$/i.test(file)) continue;
      const url = u.href;
      let label = a.textContent.replace(/\s+/g, " ").trim();
      if (!label || /^(download|pdf|view)\b/i.test(label) || label.length > 120) {
        // Cell: "Download .pdf (2 MB)" link, caption "Document S1. Figures S1–S8…" next to it
        label = file;
        let el = a.parentElement;
        for (let i = 0; i < 3 && el; i++, el = el.parentElement) {
          const t = el.textContent.replace(/\s+/g, " ").trim();
          const m = t.match(/(Document|Table|Data|Figure|Video|Peer review)[^.]*\.[^.]{0,100}/i);
          if (m) {
            label = m[0].trim();
            break;
          }
        }
      }
      if (this.SKIP_LABELS.some((re) => re.test(label) || re.test(file))) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ url, label });
    }
    return out;
  },

  /** e.g. "Harris2020" — first creator's last name + year, filesystem-safe. */
  baseName(item) {
    const creator = item.getCreators()[0];
    const name = creator ? creator.lastName || creator.name || "" : "";
    const year = (Zotero.Date.strToDate(item.getField("date")).year || "").toString();
    const safe = (name + year).normalize("NFKD").replace(/[^\w-]/g, "");
    return safe || `item${item.id}`;
  },
};

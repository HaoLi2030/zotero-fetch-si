# Sidecar

<img src="icons/icon.svg" width="72" align="right">

A Zotero 7+ plugin that attaches the files that come with a paper: Supplementary Information,
peer review files and, if missing, the main PDF. Built to work with
[Zotero Attanger](https://github.com/MuiseDestiny/zotero-attanger) in linked-file mode.

## Features

**Fetch supplements.** Right-click one or more items → *Fetch supplements & peer review*.

| Publisher | DOI prefix | SI | Peer review | Main PDF |
|---|---|---|---|---|
| Nature family | `10.1038` | ✓ | ✓ | ✓ |
| Science family | `10.1126` | ✓ | | ✓ |
| PNAS | `10.1073` | ✓ | | ✓ |
| AGU (GRL, JGR, WRR, …) | `10.1029` | ✓ | | ✓ |

- PDFs only. Reporting summaries and MDAR checklists are skipped.
- The main PDF is downloaded only when the item has none, and only if you have access
  (campus network or VPN). A paywall page is rejected, never attached.
- Running it again skips files that are already attached.
- Science, PNAS and AGU are behind Cloudflare. Sidecar uses Zotero's built-in hidden
  browser to pass the check. If a click is needed, a Zotero window opens once.

**Set file type.** Right-click attachments → *Sidecar: set file type* → Main / SI /
Peer review / Other. Renames the file and sets the title:

| Type | File name | Title |
|---|---|---|
| Main | `<name>.pdf` | Full Text PDF |
| SI | `SI_<name>.pdf`, `SI_2_<name>.pdf`, … | SI |
| Peer review | `PeerReview_<name>.pdf` | Peer Review File |
| Other | `Other_<name>.pdf`, … | Other |

`<name>` is your Zotero file-naming template for the parent item.

**Skip duplicates.** A new attachment that is byte-identical to one the item already has is
removed again. The older one, with its annotations, is kept.

**Delete = delete (macOS).** When a linked attachment is permanently deleted in Zotero, its file
goes to the macOS Trash and empty folders are removed. Only files inside Attanger's destination
folder are touched, and only if no other attachment links the same file.

## Install

Download `fetch-si.xpi` from [Releases](../../releases), then in Zotero:
Tools → Plugins → gear icon → *Install Plugin From File…*

Or build it yourself: `./build.sh` → `build/fetch-si.xpi`

## Zotero Attanger settings

New files are created as `SI.pdf`, `SI_2.pdf`, `PeerReview.pdf`. To have Attanger turn these into
`SI_<name>.pdf` and keep typed files from being renamed:

- *Keep original filename as prefix*: `^(SI|PeerReview)(_\d+)?$`
- *Skip rename*: `^(SI|PeerReview|Other)_`

## Options

Config Editor (Settings → Advanced):

| Preference | Default | Effect |
|---|---|---|
| `extensions.zotero.fetchsi.fetchMain` | `true` | Download the main PDF if missing |
| `extensions.zotero.fetchsi.skipDuplicates` | `true` | Remove byte-identical new attachments |
| `extensions.zotero.fetchsi.trashLinkedFiles` | `true` | Move deleted linked files to the macOS Trash |

## Requirements

Zotero 7 or later. Science, PNAS and AGU need Zotero 10 (`Zotero.BrowserRequest`).
Tested on Zotero 10.0.7, macOS. The UI is in English or Chinese, following Zotero's language.

## Acknowledgements

Developed with the help of AI (Claude, Anthropic). Design, testing and maintenance by the author.

## License

MIT

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Pinecone Bulk Upload GUI
Upload folders or individual files to a Pinecone index.

Requires: pip install customtkinter
"""

import os, queue, re, sys, subprocess, threading, json

# Force UTF-8 stdout/stderr on Windows (default is cp1252 which breaks on
# em-dashes, arrows, bullet chars, and emoji in this file and in subprocess output).
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import customtkinter as ctk
from tkinter import filedialog, PanedWindow
import tkinter as tk
from pathlib import Path

# ── Theme ────────────────────────────────────────────────────────────────────
ctk.set_appearance_mode("Dark")
ctk.set_default_color_theme("dark-blue")

COLORS = {
    "bg":          "#0f1115",
    "panel":       "#171a21",
    "panel_hi":    "#1e2230",
    "border":      "#262b38",
    "text":        "#e6e9ef",
    "muted":       "#8a93a6",
    "accent":      "#4f7cff",
    "accent_hi":   "#6b91ff",
    "success":     "#2ea76b",
    "success_hi":  "#3bbd7c",
    "danger":      "#d24c66",
    "danger_hi":   "#e16179",
    "log_ok":      "#7ee2a8",
    "log_err":     "#ff8aa1",
    "log_bold":    "#c9b3ff",
    "sash":        "#2d3347",
}

PAD_X = 18
PAD_Y = 10
SECTION_GAP = 10

FONT_TITLE   = ("Segoe UI", 22, "bold")
FONT_SECTION = ("Segoe UI", 13, "bold")
FONT_LABEL   = ("Segoe UI", 12)
FONT_SUBTLE  = ("Segoe UI", 11)
FONT_MONO    = ("Consolas", 12)

SCRIPT      = str(Path(__file__).parent / "pinecone_bulk.py")
CONFIG_FILE = Path(__file__).parent / "pinecone_config.json"

DOC_TYPES = ["auto-detect", "book", "kb", "notes", "markdown"]
SUPPORTED_EXTS = [
    ("Documents", "*.md *.txt *.rst *.pdf"),
    ("Markdown",  "*.md"),
    ("Text",      "*.txt"),
    ("PDF",       "*.pdf"),
    ("All files", "*.*"),
]


def section_label(parent, text):
    return ctk.CTkLabel(
        parent, text=text.upper(), font=FONT_SECTION,
        text_color=COLORS["muted"], anchor="w",
    )


def card(parent, **kw):
    return ctk.CTkFrame(
        parent, fg_color=COLORS["panel"],
        border_color=COLORS["border"], border_width=1, corner_radius=10,
        **kw,
    )


class App(ctk.CTk):
    def __init__(self):
        super().__init__()
        # Override default Tk error handler so full tracebacks are printed
        # to stderr instead of the bare "Exception in Tkinter callback" line.
        self.report_callback_exception = self._report_callback_exception

        self.title("Pinecone Upload Manager")
        self.geometry("980x920")
        self.minsize(720, 600)
        self.configure(fg_color=COLORS["bg"])
        self._process = None

        self.config_data = self._load_config()
        self._sources: list[dict] = []

        # Thread-safe queue used by the upload thread to send log lines,
        # status updates, and the final completion signal to the main thread.
        # The main thread drains it on a 40 ms timer so it never floods the
        # Tk event loop with before-idle callbacks (which was causing
        # "Not Responding").
        self._output_queue: queue.Queue = queue.Queue()
        self._upload_running: bool = False

        self._build_ui()
        self._fetch_indexes_async()

        # Restore saved settings
        if self.config_data.get("index_name"):
            self.index_name_var.set(self.config_data["index_name"])
        if self.config_data.get("namespace"):
            self.namespace_var.set(self.config_data["namespace"])
        if self.config_data.get("doc_type") in DOC_TYPES:
            self.doc_type_var.set(self.config_data["doc_type"])
        if self.config_data.get("tags"):
            self.tags_var.set(self.config_data["tags"])
        if self.config_data.get("collection"):
            self.collection_var.set(self.config_data["collection"])
        if self.config_data.get("auto_tags_from_path"):
            self.auto_tags_from_path.set(True)
        if self.config_data.get("namespace_from_top_folder"):
            self.namespace_from_top_folder.set(True)
        if self.config_data.get("collection_from_top_folder"):
            self.collection_from_top_folder.set(True)
        if self.config_data.get("doc_type_from_folder"):
            self.doc_type_from_folder.set(True)
        if "client_embed" in self.config_data:
            # Explicit key check (not truthy `.get()`) because the default is
            # True — a saved False must still be honored on restore.
            self.client_embed.set(bool(self.config_data["client_embed"]))

    # ── Configuration ────────────────────────────────────────────────────────

    def _load_config(self):
        if CONFIG_FILE.exists():
            try:
                with open(CONFIG_FILE, "r") as f:
                    return json.load(f)
            except Exception:
                pass
        return {}

    def _save_config(self):
        self.config_data["index_name"]              = self.index_name_var.get().strip()
        self.config_data["namespace"]               = self.namespace_var.get().strip()
        self.config_data["doc_type"]                = self.doc_type_var.get()
        self.config_data["tags"]                    = self.tags_var.get().strip()
        self.config_data["collection"]              = self.collection_var.get().strip()
        self.config_data["auto_tags_from_path"]     = bool(self.auto_tags_from_path.get())
        self.config_data["namespace_from_top_folder"]  = bool(self.namespace_from_top_folder.get())
        self.config_data["collection_from_top_folder"] = bool(self.collection_from_top_folder.get())
        self.config_data["doc_type_from_folder"]       = bool(self.doc_type_from_folder.get())
        self.config_data["client_embed"]               = bool(self.client_embed.get())
        try:
            with open(CONFIG_FILE, "w") as f:
                json.dump(self.config_data, f, indent=4)
        except Exception:
            pass

    # ── UI ────────────────────────────────────────────────────────────────────

    def _build_ui(self):
        """
        Layout (top-to-bottom):
          row 0 — header          (fixed)
          row 1 — settings card   (fixed)
          row 2 — behaviour card  (fixed)
          row 3 — actions bar     (fixed)
          row 4 — paned area      (stretches: sources / console separated by sash)
          row 5 — status bar      (fixed)
        """
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(4, weight=1)   # only the paned area grows

        self._build_header(row=0)
        self._build_settings_card(row=1)
        self._build_auto_rules_card(row=2)
        self._build_actions_bar(row=3)
        self._build_paned_area(row=4)
        self._build_status_bar(row=5)

    # ----- Header ------------------------------------------------------------

    def _build_header(self, row):
        wrap = ctk.CTkFrame(self, fg_color="transparent")
        wrap.grid(row=row, column=0, padx=PAD_X, pady=(PAD_X, 4), sticky="ew")
        wrap.grid_columnconfigure(0, weight=1)

        ctk.CTkLabel(
            wrap, text="Pinecone Upload Manager", font=FONT_TITLE,
            text_color=COLORS["text"], anchor="w",
        ).grid(row=0, column=0, sticky="w")

        self.connection_pill = ctk.CTkLabel(
            wrap, text="●  Connecting…", font=FONT_SUBTLE,
            text_color=COLORS["muted"], fg_color=COLORS["panel"],
            corner_radius=12, padx=10, pady=4,
        )
        self.connection_pill.grid(row=0, column=1, sticky="e")

        ctk.CTkLabel(
            wrap,
            text="multilingual-e5-large  ·  1024-dim integrated embedding",
            font=FONT_SUBTLE, text_color=COLORS["muted"], anchor="w",
        ).grid(row=1, column=0, columnspan=2, sticky="w", pady=(2, 0))

    # ----- Settings card -----------------------------------------------------

    def _build_settings_card(self, row):
        c = card(self)
        c.grid(row=row, column=0, padx=PAD_X, pady=SECTION_GAP, sticky="ew")
        c.grid_columnconfigure(1, weight=1)
        c.grid_columnconfigure(3, weight=1)

        section_label(c, "Destination").grid(
            row=0, column=0, columnspan=4, padx=14, pady=(12, 6), sticky="w"
        )

        # Index
        ctk.CTkLabel(c, text="Index", font=FONT_LABEL,
                     text_color=COLORS["muted"]).grid(
            row=1, column=0, padx=(14, 6), pady=4, sticky="w")
        self.index_name_var = ctk.StringVar()
        index_row = ctk.CTkFrame(c, fg_color="transparent")
        index_row.grid(row=1, column=1, columnspan=3, padx=(0, 14), pady=4, sticky="ew")
        index_row.grid_columnconfigure(0, weight=1)
        self.index_name_menu = ctk.CTkOptionMenu(
            index_row, variable=self.index_name_var, values=["Loading..."],
            fg_color=COLORS["panel_hi"], button_color=COLORS["accent"],
            button_hover_color=COLORS["accent_hi"], dropdown_fg_color=COLORS["panel_hi"],
        )
        self.index_name_menu.grid(row=0, column=0, sticky="ew")
        self.refresh_btn = ctk.CTkButton(
            index_row, text="↻", width=34, command=self._fetch_indexes_async,
            fg_color=COLORS["panel_hi"], hover_color=COLORS["border"],
            text_color=COLORS["text"],
        )
        self.refresh_btn.grid(row=0, column=1, padx=(6, 0))

        # Namespace + Collection
        ctk.CTkLabel(c, text="Namespace", font=FONT_LABEL,
                     text_color=COLORS["muted"]).grid(
            row=2, column=0, padx=(14, 6), pady=4, sticky="w")
        self.namespace_var = ctk.StringVar()
        ctk.CTkEntry(c, textvariable=self.namespace_var,
                     placeholder_text="(default)").grid(
            row=2, column=1, padx=(0, 14), pady=4, sticky="ew")

        ctk.CTkLabel(c, text="Collection", font=FONT_LABEL,
                     text_color=COLORS["muted"]).grid(
            row=2, column=2, padx=(14, 6), pady=4, sticky="w")
        self.collection_var = ctk.StringVar()
        ctk.CTkEntry(c, textvariable=self.collection_var,
                     placeholder_text="batch label, e.g. recall-04-05").grid(
            row=2, column=3, padx=(0, 14), pady=4, sticky="ew")

        # Metadata
        section_label(c, "Metadata").grid(
            row=3, column=0, columnspan=4, padx=14, pady=(12, 6), sticky="w"
        )
        ctk.CTkLabel(c, text="Doc type", font=FONT_LABEL,
                     text_color=COLORS["muted"]).grid(
            row=4, column=0, padx=(14, 6), pady=4, sticky="w")
        self.doc_type_var = ctk.StringVar(value="auto-detect")
        ctk.CTkOptionMenu(
            c, values=DOC_TYPES, variable=self.doc_type_var,
            fg_color=COLORS["panel_hi"], button_color=COLORS["accent"],
            button_hover_color=COLORS["accent_hi"], dropdown_fg_color=COLORS["panel_hi"],
        ).grid(row=4, column=1, padx=(0, 14), pady=4, sticky="ew")

        ctk.CTkLabel(c, text="Tags", font=FONT_LABEL,
                     text_color=COLORS["muted"]).grid(
            row=4, column=2, padx=(14, 6), pady=4, sticky="w")
        self.tags_var = ctk.StringVar()
        ctk.CTkEntry(c, textvariable=self.tags_var,
                     placeholder_text="philosophy, stoicism").grid(
            row=4, column=3, padx=(0, 14), pady=(4, 14), sticky="ew")

    # ----- Behaviour card ----------------------------------------------------

    def _build_auto_rules_card(self, row):
        c = card(self)
        c.grid(row=row, column=0, padx=PAD_X, pady=SECTION_GAP, sticky="ew")
        c.grid_columnconfigure((0, 1), weight=1)

        section_label(c, "Behaviour").grid(
            row=0, column=0, columnspan=2, padx=14, pady=(12, 6), sticky="w"
        )

        self.auto_tags_from_path          = ctk.BooleanVar(value=False)
        self.namespace_from_top_folder    = ctk.BooleanVar(value=False)
        self.collection_from_top_folder   = ctk.BooleanVar(value=False)
        self.doc_type_from_folder         = ctk.BooleanVar(value=False)
        self.recursive                = ctk.BooleanVar(value=True)
        self.dry_run                  = ctk.BooleanVar(value=False)
        self.prune_by_source          = ctk.BooleanVar(value=False)
        self.force_reupload           = ctk.BooleanVar(value=False)
        self.client_embed             = ctk.BooleanVar(value=True)

        switches = [
            ("Recurse into subfolders",                                  self.recursive),
            ("Dry run (preview only — no upload)",                       self.dry_run),
            ("Auto-tags from subfolder path",                            self.auto_tags_from_path),
            ("Auto-namespace from top folder",                           self.namespace_from_top_folder),
            ("Auto-collection from top folder",                          self.collection_from_top_folder),
            ("Auto doc-type from folder name",                           self.doc_type_from_folder),
            ("Prune stale records first (delete prior chunks)",          self.prune_by_source),
            ("Force re-embed (skip already-uploaded check)",             self.force_reupload),
            ("Embed locally (free — bypasses Pinecone embedding quota)", self.client_embed),
        ]
        for i, (label, var) in enumerate(switches):
            r   = 1 + i // 2
            col = i % 2
            ctk.CTkSwitch(
                c, text=label, variable=var,
                progress_color=COLORS["accent"],
                button_color=COLORS["text"],
                button_hover_color=COLORS["accent_hi"],
                font=FONT_LABEL, text_color=COLORS["text"],
            ).grid(row=r, column=col, padx=14, pady=4, sticky="w")

        ctk.CTkLabel(c, text="").grid(row=99, column=0, pady=(0, 6))

    # ----- Actions bar -------------------------------------------------------

    def _build_actions_bar(self, row):
        wrap = ctk.CTkFrame(self, fg_color="transparent")
        wrap.grid(row=row, column=0, padx=PAD_X, pady=(0, SECTION_GAP), sticky="ew")
        wrap.grid_columnconfigure(2, weight=1)

        self.start_btn = ctk.CTkButton(
            wrap, text="🚀  Upload to Pinecone",
            font=("Segoe UI", 13, "bold"),
            fg_color=COLORS["success"], hover_color=COLORS["success_hi"],
            text_color="white", height=42, corner_radius=10, command=self._start,
        )
        self.start_btn.grid(row=0, column=0, ipadx=14)

        self.stop_btn = ctk.CTkButton(
            wrap, text="Stop",
            font=("Segoe UI", 13, "bold"),
            fg_color=COLORS["danger"], hover_color=COLORS["danger_hi"],
            text_color="white", height=42, corner_radius=10, state="disabled",
            command=self._stop,
        )
        self.stop_btn.grid(row=0, column=1, padx=(10, 0), ipadx=14)

        self.progress = ctk.CTkProgressBar(
            wrap, mode="indeterminate",
            progress_color=COLORS["accent"],
            fg_color=COLORS["panel_hi"],
        )
        # revealed via .grid() when upload starts

    # ----- Resizable paned area (sources top / console bottom) ---------------

    def _build_paned_area(self, row):
        """
        Uses a native tkinter PanedWindow so the user can drag the sash to
        give more space to the sources list or the console at any time.

        IMPORTANT: PanedWindow is a plain Tk widget; it must live inside a
        plain tk.Frame, NOT inside a CTkFrame (which wraps content in an
        internal canvas and breaks PanedWindow's geometry propagation).
        """
        # Plain tk.Frame — transparent-looking because bg matches window bg.
        # We use pack here because it's the simplest way to fill a grid cell
        # with a plain frame that also propagates row weight.
        outer = tk.Frame(self, bg=COLORS["bg"], bd=0)
        outer.grid(row=row, column=0, padx=PAD_X, pady=(0, SECTION_GAP),
                   sticky="nsew")
        outer.grid_columnconfigure(0, weight=1)
        outer.grid_rowconfigure(0, weight=1)

        paned = PanedWindow(
            outer,
            orient=tk.VERTICAL,
            sashwidth=8,
            sashrelief=tk.FLAT,
            sashpad=0,
            bg=COLORS["sash"],
            bd=0,
            relief=tk.FLAT,
            showhandle=False,
        )
        paned.grid(row=0, column=0, sticky="nsew")

        # ── Sources pane ──────────────────────────────────────────────────
        sources_outer = tk.Frame(paned, bg=COLORS["bg"], bd=0)
        self._build_sources_card_in(sources_outer)
        paned.add(sources_outer, stretch="always", minsize=160)

        # ── Console pane ──────────────────────────────────────────────────
        console_outer = tk.Frame(paned, bg=COLORS["bg"], bd=0)
        self._build_console_in(console_outer)
        paned.add(console_outer, stretch="always", minsize=120)

    # ----- Sources card (inside paned pane) ----------------------------------

    def _build_sources_card_in(self, parent):
        """Build the sources card filling the given tk.Frame parent."""
        parent.rowconfigure(0, weight=1)
        parent.columnconfigure(0, weight=1)

        c = card(parent)
        c.grid(row=0, column=0, sticky="nsew", pady=(0, 4))
        c.grid_columnconfigure(0, weight=1)
        c.grid_rowconfigure(2, weight=1)   # scrollable list stretches

        # Header row
        head = ctk.CTkFrame(c, fg_color="transparent")
        head.grid(row=0, column=0, padx=14, pady=(12, 4), sticky="ew")
        head.grid_columnconfigure(1, weight=1)

        section_label(head, "Sources").grid(row=0, column=0, sticky="w")
        self.sources_count_label = ctk.CTkLabel(
            head, text="0 selected", font=FONT_SUBTLE,
            text_color=COLORS["muted"], anchor="w",
        )
        self.sources_count_label.grid(row=0, column=1, padx=(8, 0), sticky="w")

        # Buttons
        btns = ctk.CTkFrame(c, fg_color="transparent")
        btns.grid(row=1, column=0, padx=14, pady=(0, 8), sticky="ew")

        ctk.CTkButton(
            btns, text="＋  Add folder", command=self._add_folder,
            fg_color=COLORS["accent"], hover_color=COLORS["accent_hi"],
            text_color="white", height=34, corner_radius=8,
        ).pack(side="left", padx=(0, 8))

        ctk.CTkButton(
            btns, text="＋  Add files", command=self._add_files,
            fg_color=COLORS["accent"], hover_color=COLORS["accent_hi"],
            text_color="white", height=34, corner_radius=8,
        ).pack(side="left", padx=(0, 8))

        ctk.CTkButton(
            btns, text="Remove last", command=self._remove_last,
            fg_color="transparent", hover_color=COLORS["panel_hi"],
            text_color=COLORS["text"], border_width=1,
            border_color=COLORS["border"], height=34, corner_radius=8,
        ).pack(side="left", padx=(0, 8))

        ctk.CTkButton(
            btns, text="Clear all", command=self._clear_sources,
            fg_color="transparent", hover_color=COLORS["panel_hi"],
            text_color=COLORS["muted"], border_width=1,
            border_color=COLORS["border"], height=34, corner_radius=8,
        ).pack(side="left")

        # Scrollable list — fills remaining vertical space in the card
        self.sources_list = ctk.CTkScrollableFrame(
            c, fg_color=COLORS["panel_hi"], corner_radius=8,
        )
        self.sources_list.grid(row=2, column=0, padx=14, pady=(0, 14), sticky="nsew")
        self.sources_list.grid_columnconfigure(0, weight=1)

        self._render_sources()

    def _render_sources(self):
        for child in self.sources_list.winfo_children():
            child.destroy()

        if not self._sources:
            empty = ctk.CTkFrame(self.sources_list, fg_color="transparent")
            empty.grid(row=0, column=0, sticky="nsew")
            empty.grid_columnconfigure(0, weight=1)

            ctk.CTkLabel(
                empty, text="📥", font=("Segoe UI", 32),
                text_color=COLORS["muted"],
            ).grid(row=0, column=0, pady=(12, 4))
            ctk.CTkLabel(
                empty, text="No sources yet",
                font=("Segoe UI", 13, "bold"), text_color=COLORS["text"],
            ).grid(row=1, column=0)
            ctk.CTkLabel(
                empty,
                text='Use "＋ Add folder" to upload a whole directory, '
                     'or "＋ Add files" to pick individual .md / .txt / .rst / .pdf files.',
                font=FONT_SUBTLE, text_color=COLORS["muted"],
                wraplength=560, justify="center",
            ).grid(row=2, column=0, pady=(4, 14), padx=20)
        else:
            MAX_VISIBLE = 10
            visible = self._sources[:MAX_VISIBLE]
            for i, src in enumerate(visible):
                row_frame = ctk.CTkFrame(
                    self.sources_list, fg_color=COLORS["panel"],
                    corner_radius=6, border_width=1, border_color=COLORS["border"],
                )
                row_frame.grid(row=i, column=0, padx=4, pady=3, sticky="ew")
                # col 0: badge  col 1: icon  col 2: path (stretches)  col 3: remove btn
                row_frame.grid_columnconfigure(2, weight=1)

                badge_text  = "FOLDER" if src["kind"] == "folder" else "FILE"
                badge_color = COLORS["accent"] if src["kind"] == "folder" else COLORS["success"]
                ctk.CTkLabel(
                    row_frame, text=badge_text, font=("Segoe UI", 10, "bold"),
                    text_color="white", fg_color=badge_color,
                    corner_radius=6, padx=8, pady=2, width=68,
                ).grid(row=0, column=0, padx=(8, 8), pady=6)

                icon = "📁" if src["kind"] == "folder" else "📄"
                ctk.CTkLabel(
                    row_frame, text=icon, font=("Segoe UI", 14),
                ).grid(row=0, column=1, padx=(0, 6), pady=6)

                # Truncate long paths to last 3 components to keep rows compact.
                # Avoids the <Configure>/wraplength cascade that froze the event
                # loop when many rows were visible.
                parts = Path(src["path"]).parts
                display_path = str(Path(*parts[-3:])) if len(parts) > 3 else src["path"]

                ctk.CTkLabel(
                    row_frame, text=display_path, font=FONT_LABEL,
                    text_color=COLORS["text"], anchor="w", justify="left",
                ).grid(row=0, column=2, padx=(0, 6), pady=6, sticky="ew")

                ctk.CTkButton(
                    row_frame, text="✕", width=28, height=24,
                    fg_color="transparent", hover_color=COLORS["panel_hi"],
                    text_color=COLORS["muted"], border_width=0,
                    command=lambda idx=i: self._remove_at(idx),
                ).grid(row=0, column=3, padx=(0, 8), pady=4)

            hidden = len(self._sources) - MAX_VISIBLE
            if hidden > 0:
                summary = ctk.CTkFrame(
                    self.sources_list, fg_color="transparent",
                )
                summary.grid(row=MAX_VISIBLE, column=0, padx=4, pady=(2, 4), sticky="ew")
                ctk.CTkLabel(
                    summary,
                    text=f"… and {hidden} more (all will be uploaded — use Clear all + re-add to edit)",
                    font=FONT_SUBTLE, text_color=COLORS["muted"],
                ).pack(side="left", padx=8)

        # Update count label
        n       = len(self._sources)
        folders = sum(1 for s in self._sources if s["kind"] == "folder")
        files   = n - folders
        if n == 0:
            text = "0 selected"
        else:
            parts = []
            if folders:
                parts.append(f"{folders} folder{'s' if folders != 1 else ''}")
            if files:
                parts.append(f"{files} file{'s' if files != 1 else ''}")
            text = " · ".join(parts) + f"  ({n} total)"
        self.sources_count_label.configure(text=text)

    # ----- Console card (inside paned pane) ----------------------------------

    def _build_console_in(self, parent):
        parent.rowconfigure(0, weight=1)
        parent.columnconfigure(0, weight=1)

        c = card(parent)
        c.grid(row=0, column=0, sticky="nsew", pady=(4, 0))
        c.grid_columnconfigure(0, weight=1)
        c.grid_rowconfigure(1, weight=1)

        section_label(c, "Console").grid(
            row=0, column=0, padx=14, pady=(12, 6), sticky="w"
        )

        self.log = ctk.CTkTextbox(
            c, font=FONT_MONO, fg_color=COLORS["panel_hi"],
            text_color=COLORS["text"], border_width=0, corner_radius=8,
        )
        self.log.grid(row=1, column=0, padx=14, pady=(0, 14), sticky="nsew")
        self.log.tag_config("ok",   foreground=COLORS["log_ok"])
        self.log.tag_config("err",  foreground=COLORS["log_err"])
        self.log.tag_config("bold", foreground=COLORS["log_bold"])
        self.log.configure(state="disabled")

    # ----- Status bar --------------------------------------------------------

    def _build_status_bar(self, row):
        wrap = ctk.CTkFrame(self, fg_color="transparent")
        wrap.grid(row=row, column=0, padx=PAD_X, pady=(0, PAD_Y), sticky="ew")
        wrap.grid_columnconfigure(0, weight=1)

        self.status_label = ctk.CTkLabel(
            wrap, text="Ready.", font=FONT_SUBTLE,
            text_color=COLORS["muted"], anchor="w",
        )
        self.status_label.grid(row=0, column=0, sticky="w")

    # ── Source management ────────────────────────────────────────────────────

    def _add_folder(self):
        path = filedialog.askdirectory(title="Select folder to upload")
        if not path:
            return
        if any(s["path"] == path for s in self._sources):
            return
        self._sources.append({"path": path, "kind": "folder"})
        self._render_sources()

    def _add_files(self):
        paths = filedialog.askopenfilenames(
            title="Select files to upload", filetypes=SUPPORTED_EXTS,
        )
        if not paths:
            return
        added = 0
        for p in paths:
            if any(s["path"] == p for s in self._sources):
                continue
            self._sources.append({"path": p, "kind": "file"})
            added += 1
        if added:
            self._render_sources()

    def _remove_last(self):
        if self._sources:
            self._sources.pop()
            self._render_sources()

    def _remove_at(self, idx):
        if 0 <= idx < len(self._sources):
            self._sources.pop(idx)
            self._render_sources()

    def _clear_sources(self):
        self._sources.clear()
        self._render_sources()

    # ── Upload logic ─────────────────────────────────────────────────────────

    def _start(self):
        index_name = self.index_name_var.get().strip()
        if not index_name or index_name in [
            "Loading...", "Fetching...", "No API Key", "No indexes found",
        ]:
            self._log("Error: a valid index must be selected.\n", "err")
            return
        if not self._sources:
            self._log("No sources selected. Add at least one folder or file.\n", "err")
            return

        self._save_config()
        self.start_btn.configure(state="disabled")
        self.stop_btn.configure(state="normal")
        self._clear_log()
        self.progress.grid(row=0, column=2, padx=(14, 0), sticky="ew")
        self.progress.start()

        # Discard any stale messages from a previous run.
        try:
            while True:
                self._output_queue.get_nowait()
        except queue.Empty:
            pass

        self._upload_running = True
        self.after(40, self._drain_output)

        thread = threading.Thread(
            target=self._run_upload, args=(list(self._sources),), daemon=True,
        )
        thread.start()

    def _stop(self):
        """Request the subprocess to stop.  Non-blocking — never waits on
        the main thread, so the window stays responsive.  _upload_running
        stays True so _drain_output keeps polling; _set_idle() fires when
        the 'done' sentinel arrives from the upload thread."""
        if self._process:
            try:
                self._process.terminate()
            except Exception:
                pass
        self._log("\n[Stopped by user]\n", "err")

    def _drain_output(self):
        """Drain queued messages from the upload thread.  Called by the Tk
        event loop every 40 ms.  Processes at most 20 items per tick so
        Windows messages are handled between drains (prevents Not Responding)."""
        try:
            for _ in range(20):
                kind, *payload = self._output_queue.get_nowait()
                if kind == "log":
                    self._log(payload[0], payload[1])
                elif kind == "status":
                    self.status_label.configure(text=payload[0])
                elif kind == "done":
                    # Flush remaining log items before showing final status.
                    try:
                        while True:
                            k2, *p2 = self._output_queue.get_nowait()
                            if k2 == "log":
                                self._log(p2[0], p2[1])
                    except queue.Empty:
                        pass
                    returncode = payload[0]
                    if returncode == 0:
                        self._log("\nAll sources complete.\n", "ok")
                        self.status_label.configure(text="Done.")
                    else:
                        self._log(
                            f"\nUpload process exited with code {returncode}.\n",
                            "err",
                        )
                        self.status_label.configure(text="Failed.")
                    self._upload_running = False
                    self._set_idle()
                    return   # stop rescheduling
        except queue.Empty:
            pass

        if self._upload_running:
            self.after(40, self._drain_output)

    @staticmethod
    def _classify_line(line: str) -> str:
        s   = line.lstrip()
        low = s.lower()
        if low.startswith(("error:", "[error]")) or low.startswith("  [error]"):
            return "err"
        if "failed." in low or low.strip().rstrip(":") == "failed":
            return "err"
        if low.startswith("[retry"):
            return "bold"
        if low.startswith("done") or low.startswith("uploaded") or (
            " ok" in low and "records ok" in low
        ):
            return "ok"
        return ""

    def _run_upload(self, sources):
        """Upload thread — never calls self.after() or any Tkinter method directly.
        All UI updates go through self._output_queue and are applied by the
        main thread's _drain_output timer."""
        cmd = self._build_cmd([s["path"] for s in sources])
        folder_count = sum(1 for s in sources if s["kind"] == "folder")
        file_count   = len(sources) - folder_count
        parts = []
        if folder_count:
            parts.append(f"{folder_count} folder(s)")
        if file_count:
            parts.append(f"{file_count} file(s)")

        q = self._output_queue
        q.put(("log",    f"\n{'-' * 60}\n",                           ""))
        q.put(("log",    f"Uploading {' + '.join(parts)}\n",          "bold"))
        q.put(("log",    f"{'-' * 60}\n",                             ""))
        q.put(("status", "Uploading…"))

        _batch_re = re.compile(
            r'\bBatch\s+(\d+)/(\d+):\s+(\d+)\s+records?\s+OK', re.IGNORECASE
        )
        _embed_re = re.compile(
            r'\[embed\]\s+sub-batch\s+(\d+)/(\d+)', re.IGNORECASE
        )
        _records_ok = 0
        returncode  = -1

        try:
            self._process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                env={**os.environ,
                     "PINECONE_API_KEY":             self._get_api_key(),
                     "PYTHONIOENCODING":              "utf-8",
                     "PYTHONUNBUFFERED":              "1",
                     # Disable all tqdm progress bars in the child process.
                     # On Windows, tqdm uses \r (carriage return) to overwrite
                     # lines.  Python's text-mode pipe reader treats bare \r as
                     # a line terminator, producing thousands of short "lines"
                     # per second during e.g. model weight loading.  Even with
                     # the queue-drain approach that caps Tk work per tick,
                     # suppressing tqdm is the clean root-cause fix.
                     "TQDM_DISABLE":                 "1",
                     "HF_HUB_DISABLE_PROGRESS_BARS": "1",
                     "TOKENIZERS_PARALLELISM":        "false"},
            )
            for line in self._process.stdout:
                stripped = line.strip("\r\n ")
                if not stripped:
                    continue          # skip blank / \r-only frames
                tag = self._classify_line(line)
                q.put(("log", line, tag))

                m = _batch_re.search(line)
                if m:
                    cur, total_b, count = (
                        int(m.group(1)), int(m.group(2)), int(m.group(3))
                    )
                    _records_ok += count
                    q.put(("status",
                           f"Uploading…  {_records_ok:,} records OK  "
                           f"(batch {cur}/{total_b})"))
                    continue
                m = _embed_re.search(line)
                if m:
                    q.put(("status",
                           f"Embedding sub-batch {m.group(1)}/{m.group(2)}…"))

            returncode = self._process.wait()
        except Exception as e:
            q.put(("log", f"Error: {e}\n", "err"))
        finally:
            self._process = None

        q.put(("done", returncode))

    def _log_async(self, text, tag=""):
        """Queue a log line from any thread."""
        if text.strip("\r\n "):
            self._output_queue.put(("log", text, tag))

    def _build_cmd(self, paths):
        cmd  = [sys.executable, "-u", SCRIPT, *paths]
        cmd += ["--index-name", self.index_name_var.get().strip()]

        namespace = self.namespace_var.get().strip()
        if namespace:
            cmd += ["--namespace", namespace]

        doc = self.doc_type_var.get()
        if doc != "auto-detect":
            cmd += ["--doc-type", doc]

        tags = self.tags_var.get().strip()
        if tags:
            cmd += ["--tags", tags]

        if self.dry_run.get():
            cmd.append("--dry-run")
        if not self.recursive.get():
            cmd.append("--no-recursive")
        if self.prune_by_source.get():
            cmd.append("--prune-by-source")
        if self.force_reupload.get():
            cmd.append("--force")

        collection = self.collection_var.get().strip()
        if collection:
            cmd += ["--collection", collection]
        if self.auto_tags_from_path.get():
            cmd.append("--auto-tags-from-path")
        if self.namespace_from_top_folder.get():
            cmd.append("--namespace-from-top-folder")
        if self.collection_from_top_folder.get():
            cmd.append("--collection-from-top-folder")
        if self.doc_type_from_folder.get():
            cmd.append("--doc-type-from-folder")
        if not self.client_embed.get():
            # Local embedding is the CLI's default now; --paid-embed opts out.
            cmd.append("--paid-embed")

        return cmd

    # ── Index discovery ──────────────────────────────────────────────────────

    def _fetch_indexes_async(self):
        self.refresh_btn.configure(state="disabled")
        self.index_name_menu.configure(values=["Fetching..."])
        self.index_name_var.set("Fetching...")
        self.connection_pill.configure(text="●  Fetching…", text_color=COLORS["muted"])
        threading.Thread(target=self._fetch_indexes, daemon=True).start()

    def _fetch_indexes(self):
        api_key = self._get_api_key()
        if not api_key:
            self.after(0, lambda: self._update_index_menu(["No API Key"], "", connected=False))
            return
        try:
            import urllib.request
            req = urllib.request.Request("https://api.pinecone.io/indexes")
            req.add_header("Api-Key", api_key)
            req.add_header("X-Pinecone-Api-Version", "2024-07")
            with urllib.request.urlopen(req, timeout=10) as response:
                if response.status == 200:
                    data    = json.loads(response.read().decode("utf-8"))
                    indexes = [idx["name"] for idx in data.get("indexes", [])]
                    if not indexes:
                        self.after(0, lambda: self._update_index_menu(
                            ["No indexes found"], "", connected=True))
                    else:
                        val = self.config_data.get("index_name", indexes[0])
                        if val not in indexes:
                            val = indexes[0]
                        self.after(0, lambda: self._update_index_menu(
                            indexes, val, connected=True))
                else:
                    self.after(0, lambda: self._update_index_menu(
                        [f"Error {response.status}"], "", connected=False))
        except Exception:
            self.after(0, lambda: self._update_index_menu(
                ["Error fetching API"], "", connected=False))

    def _update_index_menu(self, values, selected, connected=False):
        self.index_name_menu.configure(values=values)
        if selected:
            self.index_name_var.set(selected)
        elif values:
            self.index_name_var.set(values[0])
        self.refresh_btn.configure(state="normal")
        if connected and values and not values[0].startswith(("Error", "No ")):
            n = len(values)
            self.connection_pill.configure(
                text=f"●  Connected  ·  {n} index{'es' if n != 1 else ''}",
                text_color=COLORS["log_ok"],
            )
        else:
            self.connection_pill.configure(
                text="●  Not connected", text_color=COLORS["log_err"],
            )

    @staticmethod
    def _get_api_key():
        key = os.environ.get("PINECONE_API_KEY", "")
        if not key:
            try:
                import winreg
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Environment") as reg:
                    key, _ = winreg.QueryValueEx(reg, "PINECONE_API_KEY")
            except Exception:
                pass
        return key

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _log(self, text, tag=""):
        self.log.configure(state="normal")
        if tag:
            self.log.insert("end", text, tag)
        else:
            self.log.insert("end", text)
        self.log.see("end")
        self.log.configure(state="disabled")

    def _clear_log(self):
        self.log.configure(state="normal")
        self.log.delete("1.0", "end")
        self.log.configure(state="disabled")

    def _set_status(self, msg):
        """Queue a status-bar update from any thread."""
        self._output_queue.put(("status", msg))

    def _set_idle(self):
        self.start_btn.configure(state="normal")
        self.stop_btn.configure(state="disabled")
        try:
            self.progress.stop()
            self.progress.grid_forget()
        except Exception:
            pass

    @staticmethod
    def _report_callback_exception(exc, val, tb):
        """Print full tracebacks to stderr instead of swallowing them."""
        import traceback
        traceback.print_exception(exc, val, tb)


if __name__ == "__main__":
    app = App()
    app.mainloop()

// Changes view: a read-only, VS Code-like source control panel for one ticket.
// File list on the left, Monaco diff editor on the right, live while the agent runs.
(function () {
  var root = document.querySelector("[data-changes-root]");
  if (!root) return;

  var POLL_MS = 3000;
  var ticketId = root.dataset.ticketId;
  var statusLabels = JSON.parse(root.dataset.statusLabels || "{}");
  var toast = window.KanbanTicket ? window.KanbanTicket.toast : function () {};

  var els = {
    badge: root.querySelector("[data-status-badge]"),
    range: root.querySelector("[data-range]"),
    live: root.querySelector("[data-live]"),
    viewButtons: root.querySelectorAll("[data-view]"),
    main: document.querySelector(".changes-main"),
    sidebar: document.querySelector("[data-sidebar]"),
    resizer: document.querySelector("[data-resizer]"),
    count: document.querySelector("[data-file-count]"),
    list: document.querySelector("[data-file-list]"),
    listEmpty: document.querySelector("[data-list-empty]"),
    fileBar: document.querySelector("[data-file-bar]"),
    editor: document.querySelector("[data-editor]"),
    placeholder: document.querySelector("[data-placeholder]"),
  };

  var state = {
    files: [],
    live: false,
    base: null,
    selected: null, // path of the selected file
    shownKey: null, // signature of the diff currently in the editor
    pollTimer: null,
    inFlight: false,
    fileSeq: 0,
    lastError: null,
  };

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch (err) {
      /* storage unavailable */
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Monaco
  // ---------------------------------------------------------------------------

  var sideBySide = store("kanban.changes.view") !== "inline";
  var darkScheme = window.matchMedia("(prefers-color-scheme: dark)");
  var diffEditor = null;
  var models = null;

  function themeName() {
    return darkScheme.matches ? "vs-dark" : "vs";
  }

  // Monaco's default blob worker can't resolve the root-relative "vs" path:
  // bootstrap the workers with absolute, same-origin URLs instead.
  window.MonacoEnvironment = {
    getWorkerUrl: function () {
      var vs = location.origin + "/vendor/monaco/vs";
      var source =
        "self.MonacoEnvironment = { baseUrl: '" + location.origin + "/vendor/monaco/' };" +
        "importScripts('" + vs + "/base/worker/workerMain.js');";
      return "data:text/javascript;charset=utf-8," + encodeURIComponent(source);
    },
  };

  var monacoReady = new Promise(function (resolve, reject) {
    window.require.config({ paths: { vs: "/vendor/monaco/vs" } });
    window.require(["vs/editor/editor.main"], function () {
      resolve(window.monaco);
    }, reject);
  });

  monacoReady.then(function (monaco) {
    diffEditor = monaco.editor.createDiffEditor(els.editor, {
      readOnly: true,
      originalEditable: false,
      renderSideBySide: sideBySide,
      automaticLayout: true,
      theme: themeName(),
      fontFamily: "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
    });
    darkScheme.addEventListener("change", function () {
      monaco.editor.setTheme(themeName());
    });
  });

  function languageFor(filePath) {
    var name = filePath.split("/").pop().toLowerCase();
    var best = "plaintext";
    var bestLen = 0;
    window.monaco.languages.getLanguages().forEach(function (lang) {
      (lang.filenames || []).forEach(function (f) {
        if (f.toLowerCase() === name && name.length > bestLen) {
          best = lang.id;
          bestLen = name.length;
        }
      });
      (lang.extensions || []).forEach(function (ext) {
        ext = ext.toLowerCase();
        if (name.endsWith(ext) && ext.length > bestLen) {
          best = lang.id;
          bestLen = ext.length;
        }
      });
    });
    return best;
  }

  // ---------------------------------------------------------------------------
  // Header
  // ---------------------------------------------------------------------------

  function shortSha(sha) {
    return sha ? sha.slice(0, 7) : "";
  }

  function renderHeader(data) {
    els.badge.textContent = statusLabels[data.status] || data.status;
    els.badge.style.setProperty("--c", "var(--status-" + data.status + ")");
    els.badge.style.setProperty("--c-soft", "var(--status-" + data.status + "-soft)");

    els.range.textContent = "";
    if (data.base) {
      els.range.append("base ");
      var base = document.createElement("code");
      base.textContent = shortSha(data.base);
      base.title = data.base;
      els.range.append(base, " → ");
      if (data.target === "WORKTREE" || !data.target) {
        els.range.append("working tree");
      } else {
        var target = document.createElement("code");
        target.textContent = shortSha(data.target);
        target.title = data.target;
        els.range.append(target);
      }
    }
    els.live.hidden = !data.live;
  }

  function renderViewToggle() {
    els.viewButtons.forEach(function (btn) {
      btn.setAttribute("aria-pressed", String((btn.dataset.view === "side") === sideBySide));
    });
  }

  els.viewButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      sideBySide = btn.dataset.view === "side";
      store("kanban.changes.view", sideBySide ? "side" : "inline");
      renderViewToggle();
      if (diffEditor) diffEditor.updateOptions({ renderSideBySide: sideBySide });
    });
  });
  renderViewToggle();

  // ---------------------------------------------------------------------------
  // File list
  // ---------------------------------------------------------------------------

  var STATUS_TITLES = { A: "Ajouté", M: "Modifié", D: "Supprimé", R: "Renommé" };

  function fileKey(file) {
    return [file.path, file.old_path, file.status, file.additions, file.deletions].join("|");
  }

  function findFile(filePath) {
    for (var i = 0; i < state.files.length; i++) {
      if (state.files[i].path === filePath) return state.files[i];
    }
    return null;
  }

  function fileItem(file) {
    var slash = file.path.lastIndexOf("/");
    var li = document.createElement("li");
    li.className = "file-item" + (file.status === "D" ? " is-deleted" : "");
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(file.path === state.selected));
    li.dataset.path = file.path;
    li.title = file.old_path ? file.old_path + " → " + file.path : file.path;

    var name = document.createElement("span");
    name.className = "file-name";
    name.textContent = file.path.slice(slash + 1);
    var dir = document.createElement("span");
    dir.className = "file-dir";
    dir.textContent = slash >= 0 ? file.path.slice(0, slash) : "";
    var label = document.createElement("span");
    label.className = "file-label";
    label.append(name, dir);

    var stats = document.createElement("span");
    stats.className = "file-stats";
    if (file.additions) {
      var add = document.createElement("span");
      add.className = "stat-add";
      add.textContent = "+" + file.additions;
      stats.append(add);
    }
    if (file.deletions) {
      var del = document.createElement("span");
      del.className = "stat-del";
      del.textContent = "−" + file.deletions;
      stats.append(del);
    }

    var status = document.createElement("span");
    status.className = "file-status status-" + file.status;
    status.textContent = file.status;
    status.title = STATUS_TITLES[file.status] || file.status;

    li.append(label, stats, status);
    return li;
  }

  function renderList(data) {
    var scrollTop = els.list.scrollTop;
    els.list.textContent = "";
    state.files.forEach(function (file) {
      els.list.append(fileItem(file));
    });
    els.list.scrollTop = scrollTop;
    els.count.textContent = String(state.files.length);

    var empty = "";
    if (!data.base) empty = "Ce ticket n'a pas encore démarré.";
    else if (!state.files.length) empty = data.live ? "L'agent n'a encore rien modifié…" : "Aucun changement.";
    els.listEmpty.textContent = empty;
    els.listEmpty.hidden = !empty;
    els.list.hidden = !!empty;
  }

  function markSelected() {
    els.list.querySelectorAll(".file-item").forEach(function (li) {
      var on = li.dataset.path === state.selected;
      li.setAttribute("aria-selected", String(on));
      if (on) li.scrollIntoView({ block: "nearest" });
    });
  }

  els.list.addEventListener("click", function (e) {
    var li = e.target.closest(".file-item");
    if (li) select(li.dataset.path);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (e.target.closest && e.target.closest(".monaco-editor, input, textarea, select")) return;
    if (!state.files.length) return;
    e.preventDefault();
    var index = -1;
    for (var i = 0; i < state.files.length; i++) {
      if (state.files[i].path === state.selected) index = i;
    }
    index = e.key === "ArrowDown" ? Math.min(state.files.length - 1, index + 1) : Math.max(0, index - 1);
    select(state.files[index].path);
  });

  // ---------------------------------------------------------------------------
  // Diff pane
  // ---------------------------------------------------------------------------

  function showPlaceholder(message) {
    els.editor.hidden = true;
    els.placeholder.hidden = false;
    els.placeholder.textContent = message;
  }

  function renderFileBar(file) {
    els.fileBar.hidden = !file;
    els.fileBar.textContent = "";
    if (!file) return;
    var status = document.createElement("span");
    status.className = "file-status status-" + file.status;
    status.textContent = file.status;
    var pathEl = document.createElement("span");
    pathEl.className = "file-bar-path";
    pathEl.textContent = file.old_path ? file.old_path + " → " + file.path : file.path;
    var kind = document.createElement("span");
    kind.className = "file-bar-kind";
    kind.textContent = STATUS_TITLES[file.status] || "";
    els.fileBar.append(status, pathEl, kind);
  }

  function select(filePath) {
    if (filePath === state.selected) return;
    state.selected = filePath;
    state.shownKey = null;
    markSelected();
    if (filePath) history.replaceState(null, "", "#" + encodeURIComponent(filePath));
    loadSelected(false);
  }

  /** Loads the selected file's diff; keepView keeps the scroll position (live reload). */
  function loadSelected(keepView) {
    var file = findFile(state.selected);
    renderFileBar(file);
    if (!file) {
      state.shownKey = null;
      showPlaceholder(state.files.length ? "Sélectionne un fichier." : els.listEmpty.textContent || "Aucun fichier à afficher.");
      return Promise.resolve();
    }
    var key = fileKey(file);
    var seq = ++state.fileSeq;
    if (!keepView) showPlaceholder("Chargement du diff…");

    var url = "/api/tickets/" + ticketId + "/changes/file?path=" + encodeURIComponent(file.path);
    return Promise.all([fetch(url).then(readJson), monacoReady])
      .then(function (results) {
        if (seq !== state.fileSeq) return; // a newer selection won
        var data = results[0];
        var monaco = results[1];
        state.shownKey = key;
        if (data.binary) return showPlaceholder("Fichier binaire : aperçu indisponible.");
        if (data.too_large) return showPlaceholder("Fichier trop volumineux (plus de 1 Mo) : aperçu indisponible.");

        var language = languageFor(file.path);
        var viewState = keepView && models ? diffEditor.saveViewState() : null;
        var previous = models;
        models = {
          original: monaco.editor.createModel(data.original, language),
          modified: monaco.editor.createModel(data.modified, language),
        };
        els.placeholder.hidden = true;
        els.editor.hidden = false;
        diffEditor.setModel(models);
        if (viewState) diffEditor.restoreViewState(viewState);
        if (previous) {
          previous.original.dispose();
          previous.modified.dispose();
        }
      })
      .catch(function (err) {
        if (seq !== state.fileSeq) return;
        showPlaceholder(err.message || "Impossible de charger le diff.");
      });
  }

  // ---------------------------------------------------------------------------
  // Data + live polling
  // ---------------------------------------------------------------------------

  function readJson(r) {
    return r.json().then(
      function (data) {
        if (!r.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Erreur " + r.status);
        return data;
      },
      function () {
        throw new Error("Erreur " + r.status);
      }
    );
  }

  function schedule() {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
    if (state.live && !document.hidden) state.pollTimer = setTimeout(refresh, POLL_MS);
  }

  function refresh() {
    if (state.inFlight) return;
    state.inFlight = true;
    fetch("/api/tickets/" + ticketId + "/changes")
      .then(readJson)
      .then(function (data) {
        var wasLive = state.live;
        state.live = data.live;
        state.base = data.base;
        state.files = data.files;
        state.lastError = null;
        renderHeader(data);

        if (!findFile(state.selected)) {
          state.selected = state.files.length ? state.files[0].path : null;
          state.shownKey = null;
        }
        renderList(data);
        markSelected();

        // Reload the diff when the selection is new, its counters moved, or for
        // the final refresh once the agent stops.
        var file = findFile(state.selected);
        var finalRefresh = wasLive && !data.live;
        if (!file || state.shownKey === null || fileKey(file) !== state.shownKey || finalRefresh) {
          return loadSelected(state.shownKey !== null);
        }
      })
      .catch(function (err) {
        if (err.message !== state.lastError) toast(err.message || "Impossible de charger les changements.", "error");
        state.lastError = err.message;
        if (!state.files.length) showPlaceholder(err.message || "Impossible de charger les changements.");
      })
      .then(function () {
        state.inFlight = false;
        schedule();
      });
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    } else if (state.live) {
      refresh();
    }
  });

  // ---------------------------------------------------------------------------
  // Resizable sidebar
  // ---------------------------------------------------------------------------

  function setSidebarWidth(px) {
    var width = Math.max(200, Math.min(640, Math.round(px)));
    els.main.style.setProperty("--sidebar-w", width + "px");
    return width;
  }

  var savedWidth = parseInt(store("kanban.changes.sidebar"), 10);
  if (savedWidth) setSidebarWidth(savedWidth);

  els.resizer.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    els.resizer.setPointerCapture(e.pointerId);
    document.body.classList.add("is-resizing");
    var left = els.sidebar.getBoundingClientRect().left;
    function move(ev) {
      setSidebarWidth(ev.clientX - left);
    }
    function up(ev) {
      els.resizer.releasePointerCapture(ev.pointerId);
      els.resizer.removeEventListener("pointermove", move);
      els.resizer.removeEventListener("pointerup", up);
      document.body.classList.remove("is-resizing");
      store("kanban.changes.sidebar", String(setSidebarWidth(ev.clientX - left)));
    }
    els.resizer.addEventListener("pointermove", move);
    els.resizer.addEventListener("pointerup", up);
  });

  els.resizer.addEventListener("dblclick", function () {
    els.main.style.removeProperty("--sidebar-w");
    store("kanban.changes.sidebar", "");
  });

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  if (location.hash.length > 1) {
    try {
      state.selected = decodeURIComponent(location.hash.slice(1));
    } catch (err) {
      /* malformed hash */
    }
  }
  monacoReady.catch(function () {
    toast("Impossible de charger l'éditeur de diff.", "error");
  });
  refresh();
})();

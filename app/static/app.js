// Cosmetic touches shared by board and ticket views: a stable colour per project
// and "il y a 5 min" style timestamps.
window.KanbanDecor = (function () {
  function hue(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  function ago(iso) {
    var date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + "Z");
    var s = Math.max(0, (Date.now() - date.getTime()) / 1000);
    if (s < 60) return "à l'instant";
    if (s < 3600) return "il y a " + Math.floor(s / 60) + " min";
    if (s < 86400) return "il y a " + Math.floor(s / 3600) + " h";
    var d = Math.floor(s / 86400);
    if (d < 7) return d === 1 ? "hier" : "il y a " + d + " jours";
    return date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  }

  function apply(root) {
    root.querySelectorAll("[data-project]").forEach(function (el) {
      el.style.setProperty("--h", hue(el.dataset.project));
    });
    root.querySelectorAll("time[data-ts]").forEach(function (el) {
      el.textContent = ago(el.dataset.ts);
    });
  }

  return { apply: apply };
})();

// Shared ticket-panel logic: used both by the board's modal and the standalone
// /tickets/{id} page, so the same fragment works in either container.
window.KanbanTicket = (function () {
  var activeStreams = {};

  function toast(message, type) {
    var container = document.getElementById("toast-container");
    if (!container || !message) return;
    var el = document.createElement("div");
    el.className = "toast" + (type ? " " + type : "");
    el.textContent = message;
    container.appendChild(el);
    setTimeout(function () {
      el.remove();
    }, 4500);
  }

  function closeStream(ticketId) {
    if (activeStreams[ticketId]) {
      activeStreams[ticketId].close();
      delete activeStreams[ticketId];
    }
  }

  function bind(container, ticketId) {
    closeStream(ticketId);

    var logsEl = container.querySelector("[data-live-logs]");
    if (logsEl && window.EventSource) {
      var evtSource = new EventSource("/api/tickets/" + ticketId + "/stream");
      evtSource.onmessage = function (e) {
        try {
          var data = JSON.parse(e.data);
          if (data.line) {
            logsEl.textContent += data.line + "\n";
            logsEl.scrollTop = logsEl.scrollHeight;
          }
        } catch (err) {
          /* ignore malformed event */
        }
      };
      activeStreams[ticketId] = evtSource;
    }

    var answerForm = container.querySelector("[data-answer-form]");
    if (answerForm) {
      answerForm.addEventListener("submit", function (e) {
        e.preventDefault();
        var btn = answerForm.querySelector("button[type=submit]");
        var message = new FormData(answerForm).get("message");
        btn.disabled = true;
        btn.textContent = "Envoi…";
        fetch("/api/tickets/" + ticketId + "/answer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: message }),
        })
          .then(function (r) {
            if (!r.ok) throw new Error("request failed");
            toast("Réponse envoyée, l'agent reprend.", "success");
            return load(container, ticketId);
          })
          .catch(function () {
            toast("Échec de l'envoi de la réponse.", "error");
            btn.disabled = false;
            btn.textContent = "Envoyer et reprendre";
          });
      });
    }

    var pushBtn = container.querySelector("[data-push-btn]");
    if (pushBtn) {
      pushBtn.addEventListener("click", function () {
        pushBtn.disabled = true;
        pushBtn.textContent = "Envoi…";
        fetch("/api/tickets/" + ticketId + "/push", { method: "POST" })
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            toast(data.message, data.ok ? "success" : "error");
            if (data.ok) {
              return load(container, ticketId);
            }
            pushBtn.disabled = false;
            pushBtn.textContent = "Valider et pousser";
          })
          .catch(function () {
            toast("Échec du push.", "error");
            pushBtn.disabled = false;
            pushBtn.textContent = "Valider et pousser";
          });
      });
    }
  }

  function load(container, ticketId) {
    return fetch("/fragments/tickets/" + ticketId)
      .then(function (r) {
        return r.text();
      })
      .then(function (html) {
        container.innerHTML = html;
        window.KanbanDecor.apply(container);
        bind(container, ticketId);
        if (window.refreshBoardSoon) window.refreshBoardSoon();
      });
  }

  return { bind: bind, load: load, closeStream: closeStream, toast: toast };
})();

// Board page: card grid, drag & drop, modal orchestration, live refresh.
(function () {
  if (!document.getElementById("board")) return; // not the board page

  var lastFocusedEl = null;
  var currentTicketId = null;

  function initSortable() {
    document
      .querySelectorAll('.card-list[data-status="a_valider"], .card-list[data-status="a_committer"]')
      .forEach(function (el) {
        new Sortable(el, {
          group: "validation",
          animation: 150,
          onEnd: function (evt) {
            var ticketId = evt.item.dataset.id;
            var newStatus = evt.to.dataset.status;
            fetch("/api/tickets/" + ticketId + "/status", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: newStatus }),
            }).then(function (r) {
              if (!r.ok) {
                window.KanbanTicket.toast("Déplacement refusé.", "error");
              }
              htmx.trigger("#board", "refresh");
            });
          },
        });
      });
  }

  // Terminé column: show a few cards, reveal more on demand, or fold the column.
  // State lives here (the board is re-rendered on every server event) and in localStorage.
  var PAGE_SIZE = 10;
  var DEFAULT_LIMIT = 3;
  var doneState = { limit: DEFAULT_LIMIT, collapsed: false };
  try {
    var saved = JSON.parse(localStorage.getItem("kanban.termine") || "null");
    if (saved) {
      if (saved.limit >= DEFAULT_LIMIT) doneState.limit = saved.limit | 0;
      doneState.collapsed = saved.collapsed === true;
    }
  } catch (err) {
    /* storage unavailable or corrupt */
  }

  function saveDoneState() {
    try {
      localStorage.setItem("kanban.termine", JSON.stringify(doneState));
    } catch (err) {
      /* ignore */
    }
  }

  function applyDoneState() {
    var col = document.querySelector(".column[data-collapsible]");
    if (!col) return;
    var cards = col.querySelectorAll(".card-list .card");
    var total = cards.length;
    cards.forEach(function (card, i) {
      card.classList.toggle("is-hidden", i >= doneState.limit);
    });
    col.classList.toggle("is-collapsed", doneState.collapsed);
    var toggle = col.querySelector("[data-column-toggle]");
    toggle.setAttribute("aria-expanded", String(!doneState.collapsed));
    toggle.setAttribute(
      "aria-label",
      (doneState.collapsed ? "Déplier" : "Replier") + " la colonne Terminé"
    );
    var more = col.querySelector("[data-more-btn]");
    if (!more) return;
    var remaining = total - doneState.limit;
    if (remaining > 0) {
      more.textContent =
        remaining > PAGE_SIZE
          ? "Voir " + PAGE_SIZE + " de plus · " + remaining + " restants"
          : "Voir les " + remaining + " derniers";
    } else {
      more.textContent = "Réduire";
    }
  }

  document.getElementById("board").addEventListener("click", function (e) {
    var toggle = e.target.closest("[data-column-toggle]");
    var more = e.target.closest("[data-more-btn]");
    if (!toggle && !more) return;
    var col = e.target.closest(".column");
    if (toggle) {
      doneState.collapsed = !doneState.collapsed;
    } else {
      var total = col.querySelectorAll(".card-list .card").length;
      if (doneState.limit >= total) {
        doneState.limit = DEFAULT_LIMIT;
        applyDoneState();
        col.querySelector(".column-header").scrollIntoView({ block: "nearest", behavior: "smooth" });
      } else {
        doneState.limit += PAGE_SIZE;
      }
    }
    saveDoneState();
    applyDoneState();
  });

  function bindCardClicks() {
    document.querySelectorAll(".card[data-id]").forEach(function (card) {
      card.addEventListener("click", function () {
        openModal(card.dataset.id);
      });
      card.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openModal(card.dataset.id);
        }
      });
    });
  }

  function openModal(ticketId) {
    var overlay = document.getElementById("modal-overlay");
    var body = document.getElementById("modal-body");
    if (!overlay || !body) return;
    lastFocusedEl = document.activeElement;
    currentTicketId = ticketId;
    body.innerHTML = "Chargement…";
    overlay.classList.add("open");
    history.pushState({ ticket: ticketId }, "", "?ticket=" + ticketId);
    window.KanbanTicket.load(body, ticketId).then(function () {
      var closeBtn = document.getElementById("modal-close-btn");
      if (closeBtn) closeBtn.focus();
    });
  }

  function closeModal(options) {
    var overlay = document.getElementById("modal-overlay");
    var body = document.getElementById("modal-body");
    if (!overlay || !overlay.classList.contains("open")) return;
    overlay.classList.remove("open");
    if (currentTicketId) window.KanbanTicket.closeStream(currentTicketId);
    currentTicketId = null;
    body.innerHTML = "";
    if (!options || !options.skipHistory) {
      history.pushState({}, "", "/");
    }
    if (lastFocusedEl) lastFocusedEl.focus();
  }

  document.getElementById("modal-close-btn").addEventListener("click", function () {
    closeModal();
  });
  document.getElementById("modal-overlay").addEventListener("click", function (e) {
    if (e.target.id === "modal-overlay") closeModal();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeModal();
  });
  window.addEventListener("popstate", function () {
    var params = new URLSearchParams(location.search);
    var ticket = params.get("ticket");
    if (ticket) {
      openModal(ticket);
    } else {
      closeModal({ skipHistory: true });
    }
  });

  document.body.addEventListener("htmx:afterSwap", function (evt) {
    if (evt.detail.target && evt.detail.target.id === "board") {
      window.KanbanDecor.apply(evt.detail.target);
      applyDoneState();
      initSortable();
      bindCardClicks();
      // Entrance animation only on the very first render, not on live refreshes.
      setTimeout(function () {
        document.body.classList.remove("first-load");
      }, 1200);
    }
  });

  var greeting = document.querySelector("[data-greeting]");
  if (greeting) {
    var hour = new Date().getHours();
    greeting.textContent = hour < 5 ? "Bonne nuit" : hour < 12 ? "Bonjour" : hour < 18 ? "Bon après-midi" : "Bonsoir";
  }

  // Keep relative timestamps fresh between live refreshes.
  setInterval(function () {
    window.KanbanDecor.apply(document.getElementById("board"));
  }, 60000);

  // Open the ticket named in ?ticket=<id> once the board has rendered at least once.
  var params = new URLSearchParams(location.search);
  var initialTicket = params.get("ticket");
  if (initialTicket) {
    document.body.addEventListener("htmx:afterSwap", function once(evt) {
      if (evt.detail.target && evt.detail.target.id === "board") {
        document.body.removeEventListener("htmx:afterSwap", once);
        openModal(initialTicket);
      }
    });
  }

  window.refreshBoardSoon = function () {
    htmx.trigger("#board", "refresh");
  };

  if (window.EventSource) {
    var boardEvents = new EventSource("/api/events");
    boardEvents.onmessage = function (e) {
      htmx.trigger("#board", "refresh");
      try {
        var data = JSON.parse(e.data);
        if (currentTicketId && String(data.ticket_id) === String(currentTicketId)) {
          window.KanbanTicket.load(document.getElementById("modal-body"), currentTicketId);
        }
      } catch (err) {
        /* ignore malformed event */
      }
    };
  }
})();

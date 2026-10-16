#!/usr/bin/env node
/**
 * Auto-ship : valide, committe et pousse automatiquement les tickets terminés.
 *
 * Boucle externe au tableau (aucune modification de l'appli) :
 *   1. « À valider »  -> « À committer » (le tableau lance alors son commit automatique)
 *   2. commit réussi  -> push (le ticket passe en « Terminé »)
 *   3. échec du commit ou du push -> journalisé, laissé à la main (pas de boucle infinie)
 *
 * Lancer :  node scripts/auto_ship.js           (tous les projets)
 *           node scripts/auto_ship.js mailac    (seulement les projets nommés)
 * Arrêter : Ctrl-C
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { DatabaseSync } from "../app/sqlite.js";

const BOARD = `http://127.0.0.1:${process.env.KANBAN_PORT ?? "8787"}`;
const DB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "kanban.db");
const POLL_SECONDS = 15;
const MAX_VALIDATIONS = 2; // par ticket : évite de re-valider sans fin un ticket renvoyé en « À valider »
const MAX_PUSH_TRIES = 3;
const PUSH_RETRY_SECONDS = 120;

const onlyProjects = new Set(process.argv.slice(2));
const validations = new Map();
const pushTries = new Map();
const lastPushTry = new Map();
const reported = new Set();

function log(msg) {
  const time = new Date().toTimeString().slice(0, 8);
  console.log(`[${time}] ${msg}`);
}

function reportOnce(ticketId, key, msg) {
  const id = `${ticketId}:${key}`;
  if (!reported.has(id)) {
    reported.add(id);
    log(msg);
  }
}

class BoardDown extends Error {}

async function api(method, apiPath, body) {
  let res;
  try {
    res = await fetch(BOARD + apiPath, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw new BoardDown(err.cause?.message ?? err.message);
  }
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // keep {} for a non-JSON error page
  }
  return [res.status, data];
}

function tickets() {
  const con = new DatabaseSync(DB, { readOnly: true });
  try {
    con.exec("PRAGMA busy_timeout = 5000");
    return con
      .prepare(
        "select t.id, t.title, t.status, t.commit_message, t.error_message, p.name as project " +
          "from ticket t join project p on p.id = t.project_id " +
          "where t.status in ('a_valider', 'a_committer') order by t.id"
      )
      .all();
  } finally {
    con.close();
  }
}

async function tick() {
  for (const t of tickets()) {
    if (onlyProjects.size && !onlyProjects.has(t.project)) continue;
    const tid = t.id;
    const name = `${t.project} · ${t.title}`;

    if (t.status === "a_valider") {
      if ((validations.get(tid) ?? 0) >= MAX_VALIDATIONS) {
        reportOnce(tid, "max-valid", `⏸  ${name} : revenu en « À valider » plusieurs fois, je le laisse à ta relecture.`);
        continue;
      }
      const [code, res] = await api("PATCH", `/api/tickets/${tid}/status`, { status: "a_committer" });
      if (code === 200) {
        validations.set(tid, (validations.get(tid) ?? 0) + 1);
        log(`✔  validé, commit automatique lancé : ${name}`);
      } else {
        reportOnce(tid, `valid-${code}`, `✖  validation refusée (${code} ${res.detail ?? ""}) : ${name}`);
      }
    } else if (t.status === "a_committer") {
      if (t.error_message) {
        reportOnce(tid, "commit-err", `✖  commit échoué, à reprendre à la main : ${name}\n     ${t.error_message}`);
        continue;
      }
      if (!t.commit_message) continue; // le commit automatique tourne encore
      if ((pushTries.get(tid) ?? 0) >= MAX_PUSH_TRIES) {
        reportOnce(tid, "max-push", `⏸  push abandonné après ${MAX_PUSH_TRIES} essais : ${name}`);
        continue;
      }
      if (Date.now() / 1000 - (lastPushTry.get(tid) ?? 0) < PUSH_RETRY_SECONDS) continue;
      pushTries.set(tid, (pushTries.get(tid) ?? 0) + 1);
      lastPushTry.set(tid, Date.now() / 1000);
      const [code, res] = await api("POST", `/api/tickets/${tid}/push`);
      if (code === 200 && res.ok) {
        log(`⬆  poussé, ticket terminé : ${name}`);
      } else {
        log(`✖  push échoué (essai ${pushTries.get(tid)}/${MAX_PUSH_TRIES}) : ${name}\n     ${res.message || res.detail}`);
      }
    }
  }
}

async function main() {
  const scope = [...onlyProjects].sort().join(", ") || "tous les projets";
  log(`auto-ship démarré (${scope}), vérification toutes les ${POLL_SECONDS} s. Ctrl-C pour arrêter.`);
  for (;;) {
    try {
      await tick();
      reported.delete("0:down-BoardDown");
    } catch (err) {
      const kind = err instanceof BoardDown ? "BoardDown" : err.code ?? err.name;
      reportOnce(0, `down-${kind}`, `…  tableau injoignable (${err.message}), je réessaie.`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_SECONDS * 1000));
  }
}

process.on("SIGINT", () => {
  log("auto-ship arrêté.");
  process.exit(0);
});

main();

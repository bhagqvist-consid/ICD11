// ====== KONFIG ======
const API_BASE = "http://icd11kt01v:6382"; // <-- din öppna lokala endpoint
const RELEASE_ID = "2025-01";
const LINEARIZATION = "mms";
const API_VERSION = "v2";
const LANG = "sv";

const MIN = 3;
const DEBOUNCE_MS = 300;

// Concurrency-limit för att ladda scaleEntity-listor snabbt men snällt
const AXIS_PREFETCH_CONCURRENCY = 6;

// ====== UI refs ======
const q = document.getElementById("q");
const list = document.getElementById("suggestions");
const statusEl = document.getElementById("status");
const selectedEl = document.getElementById("selected");
const postcoordEl = document.getElementById("postcoord");
const confirmBtn = document.getElementById("confirm");
const confirmHelp = document.getElementById("confirmHelp");

const clusterBox = document.getElementById("clusterBox");
const clusterCodeEl = document.getElementById("clusterCode");
const clusterMetaEl = document.getElementById("clusterMeta");

// Footer i postcoord (måste finnas i index.html enligt senaste versionen)
const postcoordFooter = document.getElementById("postcoordFooter");
const selectedAxisUrisEl = document.getElementById("selectedAxisUris");
const compactClusterEl = document.getElementById("compactCluster");

const ICD_CLUSTER_RULES = {
  // &-gruppen: “inline modifiers” (ex anatomi, severity)
  amp: new Set([
    "http://id.who.int/icd/schema/hasSeverity",
    "http://id.who.int/icd/schema/hasAnatomy",
    "http://id.who.int/icd/schema/hasTopography",
    "http://id.who.int/icd/schema/hasLaterality",
    "http://id.who.int/icd/schema/hasSubstance",
    "http://id.who.int/icd/schema/hasTemporality",
  ]),

  // /-gruppen: “linked conditions” (ex manifestation/etiologi/bidiagnos)
  slash: new Set([
    "http://id.who.int/icd/schema/hasCausingCondition",
    "http://id.who.int/icd/schema/hasManifestation",
    "http://id.who.int/icd/schema/hasAssociatedCondition",
    "http://id.who.int/icd/schema/associatedWith", // om du vill räkna den som länkad
  ]),

  // ordning inom &-delen (vänster→höger)
  ampOrder: [
    "http://id.who.int/icd/schema/hasAnatomy",
    "http://id.who.int/icd/schema/hasTopography",
    "http://id.who.int/icd/schema/hasLaterality",
    "http://id.who.int/icd/schema/hasSeverity",
    "http://id.who.int/icd/schema/hasTemporality",
    "http://id.who.int/icd/schema/hasSubstance",
  ],

  // ordning inom /-delen
  slashOrder: [
    "http://id.who.int/icd/schema/hasManifestation",
    "http://id.who.int/icd/schema/hasCausingCondition",
    "http://id.who.int/icd/schema/hasAssociatedCondition",
    "http://id.who.int/icd/schema/associatedWith",
  ],
};


// ====== state ======
let items = [];
let activeIndex = -1;

let selectedEntity = null;
let currentAxesDef = [];   // normalizePostcoord output
let axisState = new Map(); // axisLabel -> { required, allowMultiple, selected: [opt], options: [opt] }

// cache för entity-fetchar
const entityCache = new Map();

// ====== helpers ======
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
function setStatus(msg) { statusEl.textContent = msg || ""; }

function apiHeaders() {
  return {
    "Accept": "application/json",
    "API-Version": API_VERSION,
    "Accept-Language": LANG,
  };
}
function escapeHtml(s) {
  return (s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}
function stripTags(html) {
  return String(html ?? "").replace(/<[^>]*>/g, "");
}
function sanitizeFoundEm(html) {
  const s = String(html ?? "");
  const tokenOpen = "___EM_FOUND_OPEN___";
  const tokenClose = "___EM_CLOSE___";

  const tokenized = s
    .replaceAll("<em class='found'>", tokenOpen)
    .replaceAll('<em class="found">', tokenOpen)
    .replaceAll("</em>", tokenClose);

  const escaped = escapeHtml(tokenized);

  return escaped
    .replaceAll(tokenOpen, "<em class=\"found\">")
    .replaceAll(tokenClose, "</em>");
}
function firstUri(maybeMulti) {
  const s = String(maybeMulti ?? "").trim();
  if (!s) return "";
  return s.split(" / ")[0].trim();
}
function getEntityTitle(ent) {
  return ent?.title?.["@value"] || ent?.title?.value || (typeof ent?.title === "string" ? ent.title : "") || "";
}
function getEntityCode(ent) {
  return ent?.theCode || ent?.code || "";
}
function getBaseCode(entity) {
  return entity?.theCode || entity?.code || "";
}

function axisLabelFromUri(axisUri) {
  const s = String(axisUri || "");
  const last = s.split("/").pop() || s;
  return last.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, c => c.toUpperCase());
}
function shortAxisKey(axisUriOrLabel) {
  const s = String(axisUriOrLabel || "");
  return s.includes("/") ? (s.split("/").pop() || s) : s;
}

async function mapWithConcurrency(itemsArr, limit, mapper) {
  const results = new Array(itemsArr.length);
  let i = 0;

  async function worker() {
    while (i < itemsArr.length) {
      const idx = i++;
      results[idx] = await mapper(itemsArr[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.min(limit, itemsArr.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ====== listbox UI ======
function clearList() {
  items = [];
  activeIndex = -1;
  list.innerHTML = "";
  q.setAttribute("aria-expanded", "false");
  q.setAttribute("aria-activedescendant", "");
}
function renderList() {
  list.innerHTML = "";
  items.forEach((it, i) => {
    const li = document.createElement("li");
    li.id = `opt-${i}`;
    li.className = "option" + (i === activeIndex ? " active" : "");
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", i === activeIndex ? "true" : "false");
    li.innerHTML = `
      <div><strong>${sanitizeFoundEm(it.titleHtml)}</strong></div>
      <div class="small">${escapeHtml(it.code || "")}</div>
    `;
    li.addEventListener("mousedown", (e) => { e.preventDefault(); pick(i); });
    list.appendChild(li);
  });

  q.setAttribute("aria-expanded", items.length ? "true" : "false");
  if (activeIndex >= 0) q.setAttribute("aria-activedescendant", `opt-${activeIndex}`);
}

// ====== API calls ======
async function searchMms(term) {
  const url = new URL(`${API_BASE}/icd/release/11/${RELEASE_ID}/${LINEARIZATION}/search`);
  url.searchParams.set("q", term);

  // som ditt exempel:
  url.searchParams.set("subtreeFilterUsesFoundationDescendants", "false");
  url.searchParams.set("includeKeywordResult", "false");
  url.searchParams.set("useFlexisearch", "false");
  url.searchParams.set("flatResults", "true");
  url.searchParams.set("highlightingEnabled", "true");
  url.searchParams.set("medicalCodingMode", "true");

  const res = await fetch(url, { headers: apiHeaders() });
  if (!res.ok) throw new Error(`Sökning misslyckades (${res.status})`);

  const data = await res.json();
  const arr = data.destinationEntities || [];

  return arr.map(x => ({
    idUri: x.id,
    titleHtml: x.title || "",
    code: x.theCode || "",
    isLeaf: x.isLeaf,
    postcoordinationAvailability: x.postcoordinationAvailability
  }));
}

async function fetchEntityByUri(uri) {
  const u = new URL(firstUri(uri));
  const directUrl = new URL(u.pathname + u.search, API_BASE);
  const res = await fetch(directUrl, { headers: apiHeaders() });
  if (!res.ok) throw new Error(`Entity-hämtning misslyckades (${res.status})`);
  return await res.json();
}
async function fetchEntityCached(uri) {
  const key = firstUri(uri);
  if (entityCache.has(key)) return entityCache.get(key);
  const ent = await fetchEntityByUri(key);
  entityCache.set(key, ent);
  return ent;
}

// ====== selection rendering ======
function renderSelected(entity, fromItem = null) {
  selectedEl.hidden = false;

  const title = getEntityTitle(entity) || (fromItem ? stripTags(fromItem.titleHtml) : "");
  const code = getEntityCode(entity) || (fromItem ? fromItem.code : "");

  selectedEl.innerHTML = `
    <div class="row">
      <div><strong>${escapeHtml(title)}</strong></div>
      ${code ? `<span class="badge">${escapeHtml(code)}</span>` : ""}
    </div>
    <div class="small">URI: ${escapeHtml(entity["@id"] || entity.id || fromItem?.idUri || "")}</div>
  `;
}

function renderBlock(entity) {
  selectedEl.hidden = false;

  const title = getEntityTitle(entity);
  const codeRange = entity.codeRange || "";
  const defn = entity.definition?.["@value"] || "";

  const children = Array.isArray(entity.child) ? entity.child : [];

  selectedEl.innerHTML = `
    <div class="row">
      <div><strong>${escapeHtml(title)}</strong></div>
      ${codeRange ? `<span class="badge">${escapeHtml(codeRange)}</span>` : ""}
    </div>
    ${defn ? `<p class="small">${escapeHtml(defn)}</p>` : ""}
    <div class="hint">Detta är ett block. Välj en diagnos inom blocket:</div>
    <ul id="blockChildren" class="listbox" role="listbox" aria-label="Diagnoser i block"></ul>
  `;

  const ul = document.getElementById("blockChildren");
  ul.innerHTML = "";

  children.forEach((childUri, idx) => {
    const li = document.createElement("li");
    li.className = "option";
    li.setAttribute("role", "option");
    li.textContent = `Laddar… (${idx + 1}/${children.length})`;
    ul.appendChild(li);

    fetchEntityCached(childUri).then(childEnt => {
      const childTitle = getEntityTitle(childEnt) || childUri;
      const childCode = getEntityCode(childEnt) || "";
      li.innerHTML = `<strong>${escapeHtml(childTitle)}</strong><div class="small">${escapeHtml(childCode)}</div>`;
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        handleEntitySelected(childEnt, null);
      });
    }).catch(() => {
      li.textContent = `Kunde inte ladda: ${childUri}`;
    });
  });
}

// ====== postcoordination parsing ======
function normalizePostcoord(entityJson) {
  const scale = Array.isArray(entityJson.postcoordinationScale)
    ? entityJson.postcoordinationScale
    : [];
console.log(scale);
  
  let result = scale.map(ax => ({
    id: ax["@id"] || "",
    axisUri: ax.axisName || "",
    axisLabel: axisLabelFromUri(ax.axisName),
    required: String(ax.requiredPostcoordination).toLowerCase() === "true",
    allowMultiple:
      String(ax.allowMultipleValues).toLowerCase() === "allowalways" ||
      String(ax.allowMultipleValues).toLowerCase() === "allowifdifferent" ||
      String(ax.allowMultipleValues).toLowerCase() === "allowifunique",
    scaleEntity: Array.isArray(ax.scaleEntity) ? ax.scaleEntity : []
  }));
  return result;
}

// ====== cluster outputs ======
function buildClusterString(entity, axesDef) {
  const base = getBaseCode(entity);
  if (!base) return "";

  const parts = [];
  for (const ax of axesDef) {
    const st = axisState.get(ax.axisLabel);
    if (!st || !st.selected || st.selected.length === 0) continue;

    const axisKey = shortAxisKey(ax.axisUri || ax.axisLabel);
    const codes = st.selected.map(v => v.code || v.uri || v.title).join(",");
    parts.push(`${axisKey}=${codes}`);
  }
  return parts.length ? `${base}|${parts.join(";")}` : base;
}

function renderClusterPreview(clusterStr, entity) {
  if (!clusterStr) { clusterBox.hidden = true; return; }
  clusterBox.hidden = false;
  //clusterCodeEl.textContent = clusterStr;
  const title = getEntityTitle(entity);
  clusterMetaEl.textContent = title ? `Bas: ${title}` : "";
}

function buildAxisUriSummary(axesDef) {
  const lines = [];
  for (const ax of axesDef) {
    const st = axisState.get(ax.axisLabel);
    if (!st || !st.selected || st.selected.length === 0) continue;

    const axis = ax.axisLabel;
    const axisUri = ax.axisUri || "";
    const uris = st.selected.map(v => v.uri).filter(Boolean);

    lines.push(`${axis} (${axisUri}): ${uris.join(", ")}`);
  }
  return lines.length ? lines.join("\n") : "";
}

function buildCompactCodeCluster(entity, axesDef) {
  const base = getBaseCode(entity);
  if (!base) return "";

  const codes = new Set();
  for (const ax of axesDef) {
    const st = axisState.get(ax.axisLabel);
    if (!st || !st.selected || st.selected.length === 0) continue;
    for (const v of st.selected) {
      if (v.code && String(v.code).trim()) codes.add(String(v.code).trim());
      else if (v.uri) codes.add(String(v.uri).trim());
    }
  }
  if (codes.size === 0) return base;
  return [base, ...Array.from(codes)].join("+");
}

// ====== valueset expansion for grouped headers ======
function isGroupEntity(ent) {
  const kind = String(ent?.classKind || "").toLowerCase();
  const hasChildren = Array.isArray(ent?.child) && ent.child.length > 0;
  const code = (getEntityCode(ent) || "").trim();
  return kind === "block" || (hasChildren && code === "");
}

async function expandScaleEntityUri(uri) {
  const ent = await fetchEntityCached(uri);
  const title = getEntityTitle(ent) || uri;
  const code = getEntityCode(ent) || "";
  const children = Array.isArray(ent.child) ? ent.child : [];

  if (isGroupEntity(ent)) {
    const groupTitle = title;
    const childOpts = await mapWithConcurrency(children, AXIS_PREFETCH_CONCURRENCY, async (childUri) => {
      const childEnt = await fetchEntityCached(childUri);
      return {
        uri: firstUri(childUri),
        title: getEntityTitle(childEnt) || childUri,
        code: getEntityCode(childEnt) || "",
        group: groupTitle
      };
    });

    return childOpts.filter(o => (o.title || "").trim() !== "");
  }

  return [{
    uri: firstUri(uri),
    title,
    code,
    group: null
  }];
}

async function prefetchAxisOptions(ax) {
  const expanded = await mapWithConcurrency(ax.scaleEntity, AXIS_PREFETCH_CONCURRENCY, async (uri) => {
    return await expandScaleEntityUri(uri);
  });

  const flat = expanded.flat();

  flat.sort((a, b) => {
    const ag = (a.group || "").toLowerCase();
    const bg = (b.group || "").toLowerCase();
    if (ag !== bg) return ag < bg ? -1 : 1;

    const ak = (a.code || "").toLowerCase();
    const bk = (b.code || "").toLowerCase();
    if (ak && bk && ak !== bk) return ak < bk ? -1 : 1;

    const at = (a.title || "").toLowerCase();
    const bt = (b.title || "").toLowerCase();
    return at < bt ? -1 : at > bt ? 1 : 0;
  });

  return flat;
}

// ====== renderPostcoord (hela) ======
async function renderPostcoord(axes) {
  currentAxesDef = axes;

  postcoordEl.hidden = false;

  // postcoordEl innehåller footer-noder. Rensa endast "body".
  let body = document.getElementById("postcoordBody");
  if (!body) {
    body = document.createElement("div");
    body.id = "postcoordBody";
    if (postcoordFooter && postcoordFooter.parentElement === postcoordEl) {
      postcoordEl.insertBefore(body, postcoordFooter);
    } else {
      postcoordEl.appendChild(body);
    }
  }
  body.innerHTML = "";
  axisState.clear();

  function updateConfirmAndFooter() {
    const missing = [];
    axisState.forEach((st, name) => {
      if (st.required && (!st.selected || st.selected.length === 0)) missing.push(name);
    });

    confirmBtn.disabled = missing.length > 0;
    confirmHelp.textContent = missing.length
      ? `Fyll i obligatorisk postkoordinering: ${missing.join(", ")}.`
      : "";

    const clusterStr = selectedEntity ? buildClusterString(selectedEntity, currentAxesDef) : "";
    renderClusterPreview(clusterStr, selectedEntity);

    const axisSummary = buildAxisUriSummary(currentAxesDef);
    //const compact = selectedEntity ? buildCompactCodeCluster(selectedEntity, currentAxesDef) : "";
    const compact = selectedEntity ? buildIcdStyleCluster(selectedEntity, currentAxesDef) : "";

    if (postcoordFooter) {
      postcoordFooter.hidden = !(axisSummary || compact || getBaseCode(selectedEntity));
      if (selectedAxisUrisEl) selectedAxisUrisEl.textContent = axisSummary || "—";
      if (compactClusterEl) compactClusterEl.textContent = compact || (getBaseCode(selectedEntity) || "—");
    }
  }

  if (!axes.length) {
    const div = document.createElement("div");
    div.className = "hint";
    div.textContent = "Ingen postkoordinering för denna kod.";
    body.appendChild(div);

    confirmBtn.disabled = false;
    confirmHelp.textContent = "";

    updateConfirmAndFooter();
    return;
  }

  // Initiera state
  axes.forEach(ax => {
	  console.log(ax.axisLabel, ax.allowMultiple, ax.required);
    axisState.set(ax.axisLabel, {
      required: ax.required,
      allowMultiple: ax.allowMultiple,
      selected: [],
      options: []
    });
  });

  const loading = document.createElement("div");
  loading.className = "hint";
  loading.textContent = "Laddar postkoordineringsvärden…";
  body.appendChild(loading);

  try {
    const axisOptions = await Promise.all(
      axes.map(async (ax) => ({ axis: ax, options: await prefetchAxisOptions(ax) }))
    );

    body.innerHTML = "";

    axisOptions.forEach(({ axis: ax, options }, idx) => {
      const st = axisState.get(ax.axisLabel);
      st.options = options;

      const details = document.createElement("details");
      details.open = ax.required;

      const summaryText = `${ax.axisLabel}${ax.required ? " (obligatorisk)" : ""} — ${options.length} val`;
      details.innerHTML = `
        <summary>${escapeHtml(summaryText)}</summary>
        <div class="axisBody">
          <div class="hint">${st.allowMultiple ? "Flera val tillåtna." : "Endast ett val tillåtet."}</div>

          <fieldset id="fs-${idx}">
            <legend class="small">${escapeHtml(ax.axisLabel)}</legend>
            <div id="choices-${idx}"></div>
          </fieldset>

          <div class="row">
            <button type="button" class="btn" id="clear-${idx}">Rensa</button>
          </div>

          <div class="hint" id="sel-${idx}" aria-live="polite"></div>
        </div>
      `;
      body.appendChild(details);

      const choices = details.querySelector(`#choices-${idx}`);
      const sel = details.querySelector(`#sel-${idx}`);
      const clearBtn = details.querySelector(`#clear-${idx}`);

      function renderSelectedText() {
        if (!st.selected.length) {
          sel.textContent = "";
        } else {
          sel.textContent =
            "Valt: " +
            st.selected.map(x => (x.code ? `${x.code} – ${x.title}` : x.title)).join("; ");
        }
      }

      const inputType = st.allowMultiple ? "checkbox" : "radio";
      const name = `ax-${idx}`;

      let lastGroup = null;

      options.forEach((opt, j) => {
        if (opt.group && opt.group !== lastGroup) {
          lastGroup = opt.group;
          const g = document.createElement("div");
          g.className = "hint";
          g.innerHTML = `<strong>${escapeHtml(opt.group)}</strong>`;
          choices.appendChild(g);
        } else if (!opt.group && lastGroup !== null) {
          lastGroup = null;
        }

        const id = `ax-${idx}-${j}`;
        const row = document.createElement("div");
        row.className = "choice";

        row.innerHTML = `
          <input id="${escapeHtml(id)}" type="${inputType}" name="${escapeHtml(name)}" />
          <label class="choiceLabel" for="${escapeHtml(id)}">
            <strong>${escapeHtml(opt.title)}</strong>
            <div class="small">${escapeHtml(opt.code)}</div>
          </label>
        `;

        const input = row.querySelector("input");

        input.addEventListener("change", () => {
          if (!st.allowMultiple) {
            st.selected = input.checked ? [opt] : [];
          } else {
            const exists = st.selected.some(x => x.uri === opt.uri);
            st.selected = input.checked
              ? (exists ? st.selected : [...st.selected, opt])
              : st.selected.filter(x => x.uri !== opt.uri);
          }
          renderSelectedText();
          updateConfirmAndFooter();
        });

        choices.appendChild(row);
      });

      clearBtn.addEventListener("click", () => {
        st.selected = [];
        details.querySelectorAll("input").forEach(inp => { inp.checked = false; });
        renderSelectedText();
        updateConfirmAndFooter();
      });

      renderSelectedText();
    });

    updateConfirmAndFooter();
  } catch (err) {
    body.innerHTML = `<div class="hint">Kunde inte ladda postkoordinering: ${escapeHtml(err.message)}</div>`;
    confirmBtn.disabled = true;
    confirmHelp.textContent = "Postkoordinering kunde inte laddas.";
    updateConfirmAndFooter();
  }
}

// ====== central selection handler ======
async function handleEntitySelected(entity, fromItem = null) {
  selectedEntity = entity;

  // reset UI
  currentAxesDef = [];
  axisState.clear();

  postcoordEl.hidden = true;
  confirmBtn.disabled = true;
  confirmHelp.textContent = "";
  clusterBox.hidden = true;
  if (postcoordFooter) postcoordFooter.hidden = true;

  const kind = String(entity.classKind || "").toLowerCase();

  if (kind === "block") {
    renderBlock(entity);
    confirmHelp.textContent = "Välj en diagnos inom blocket.";
    setStatus("");
    return;
  }

  renderSelected(entity, fromItem);

  const axes = normalizePostcoord(entity);
  postcoordEl.hidden = false;
  await renderPostcoord(axes);

  setStatus("");
}

// ====== pick from search list ======
async function pick(i) {
  const it = items[i];
  clearList();
  q.value = stripTags(it.titleHtml);

  setStatus("Hämtar detaljer…");
  try {
console.log(654, it.idUri);
    const entity = await fetchEntityCached(it.idUri);
    await handleEntitySelected(entity, it);
  } catch (err) {
    setStatus(err.message);
  }
}

// ====== search input handlers ======
const onInput = debounce(async () => {
  const term = q.value.trim();
  if (term.length < MIN) { clearList(); setStatus(""); return; }

  try {
    setStatus("Söker…");
    const res = await searchMms(term);
    items = res.slice(0, 10);
    activeIndex = items.length ? 0 : -1;
    renderList();
    setStatus(items.length ? `${items.length} förslag.` : "Inga träffar.");
  } catch (e) {
    setStatus(e.message);
  }
}, DEBOUNCE_MS);

q.addEventListener("input", onInput);

q.addEventListener("keydown", (e) => {
  if (!items.length) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeIndex = Math.min(activeIndex + 1, items.length - 1);
    renderList();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeIndex = Math.max(activeIndex - 1, 0);
    renderList();
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (activeIndex >= 0) pick(activeIndex);
  } else if (e.key === "Escape") {
    clearList();
  }
});

// ====== confirm button (store string) ======
confirmBtn.addEventListener("click", async () => {
  //const clusterStr = buildClusterString(selectedEntity, currentAxesDef) || getBaseCode(selectedEntity) || "";
  const compact = selectedEntity ? buildIcdStyleCluster(selectedEntity, currentAxesDef) : "";
  if (!compact) {
    setStatus("Ingen kod att använda.");
    return;
  }

  try {
    await navigator.clipboard.writeText(compact);
    setStatus("Kodkluster kopierat till urklipp.");
  } catch {
    setStatus("Kodkluster klart (kunde inte kopiera automatiskt).");
  }

  // Exempel på lagring:
  console.log("STORE(cluster):", compact);
  // console.log("STORE(compact):", buildIcdStyleCluster(selectedEntity, currentAxesDef));
});

function axisUriForLabel(axesDef, axisLabel) {
  const ax = axesDef.find(a => a.axisLabel === axisLabel);
  return ax?.axisUri || "";
}

function selectedCodesForAxisLabel(axisLabel) {
  const st = axisState.get(axisLabel);
  if (!st?.selected?.length) return [];
  return st.selected
    .map(v => (v.code && String(v.code).trim()) ? String(v.code).trim() : "")
    .filter(Boolean);
}

// “Kortast form” enligt separator-reglerna: base + (& modifiers) + (/ linked)
function buildIcdStyleCluster(entity, axesDef) {
  const base = getBaseCode(entity);
  if (!base) return "";
  let description = getEntityTitle(entity);

  // Samla val per axisUri
  const byAxisUri = new Map(); // axisUri -> [codes]
  for (const ax of axesDef) {
    const codes = selectedCodesForAxisLabel(ax.axisLabel);
    if (codes.length) byAxisUri.set(ax.axisUri, codes);
  }

  // Bygg &-delen i ordning
  const ampCodes = [];
  for (const uri of ICD_CLUSTER_RULES.ampOrder) {
    const codes = byAxisUri.get(uri);
    if (codes?.length) ampCodes.push(...codes);
  }
  // om något &-axis inte finns i ampOrder men ändå klassas som amp, lägg sist:
  for (const [uri, codes] of byAxisUri.entries()) {
    if (ICD_CLUSTER_RULES.amp.has(uri) && !ICD_CLUSTER_RULES.ampOrder.includes(uri)) {
      ampCodes.push(...codes);
    }
  }

  // Bygg /-delen i ordning
  const slashCodes = [];
  for (const uri of ICD_CLUSTER_RULES.slashOrder) {
    const codes = byAxisUri.get(uri);
    if (codes?.length) slashCodes.push(...codes);
  }
  // och ev okända slash-axlar sist:
  for (const [uri, codes] of byAxisUri.entries()) {
    if (ICD_CLUSTER_RULES.slash.has(uri) && !ICD_CLUSTER_RULES.slashOrder.includes(uri)) {
      slashCodes.push(...codes);
    }
  }

  // För axlar som inte matchar någon grupp: lägg i & som fallback (eller skapa egen grupp)
  const otherCodes = [];
  for (const [uri, codes] of byAxisUri.entries()) {
    const inAmp = ICD_CLUSTER_RULES.amp.has(uri);
    const inSlash = ICD_CLUSTER_RULES.slash.has(uri);
    if (!inAmp && !inSlash) otherCodes.push(...codes);
  }
  // Sätt ihop:
  // base & ampCodes & otherCodes / slashCodes
  let s = base;

  let sep = ": "; 
  for (const c of [...ampCodes, ...otherCodes]) {
    s += `&${c}`;
    description += sep + c;
    sep = ", ";
  }
  sep = " samt ";
  for (const c of slashCodes) {
    s += `/${c}`;
    description += sep + c;
    sep = ", ";
  }

  console.log("description", description);
  return s;
}


// The update window: shows the new version's What's New notes, then download and install progress.
const api = window.vibecadUpdate;
const notes = document.getElementById("notes");
const progress = document.getElementById("progress");
const error = document.getElementById("error");
const later = document.getElementById("later");
const install = document.getElementById("install");

// Only plain text structure survives from the release notes; links must be web links.
const KEEP = new Set(["P", "UL", "OL", "LI", "A", "CODE", "STRONG", "EM", "B", "I", "BR", "H4", "H5", "H6"]);
function clean(node) {
  if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent);
  if (node.nodeType !== Node.ELEMENT_NODE) return document.createDocumentFragment();
  const out = KEEP.has(node.tagName) ? document.createElement(node.tagName) : document.createDocumentFragment();
  if (node.tagName === "A") {
    const href = node.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) out.href = href;
  }
  for (const child of node.childNodes) out.append(clean(child));
  return out;
}

/** The section under a "What's New" (or GitHub's "What's Changed") heading, up to the next heading of its level. */
function whatsNew(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const head = [...doc.body.querySelectorAll("h1, h2, h3")].find((h) => /what\W*s\s+(new|changed)/i.test(h.textContent));
  if (!head) return null;
  const level = Number(head.tagName[1]);
  const out = document.createDocumentFragment();
  for (let n = head.nextSibling; n; n = n.nextSibling) {
    if (/^H[1-6]$/.test(n.nodeName) && Number(n.nodeName[1]) <= level) break;
    out.append(clean(n));
  }
  return out.textContent.trim() ? out : null;
}

// The window fits its content, up to the main process's limit, past which the notes scroll.
function fit() {
  const fixed = document.querySelector("header").offsetHeight + document.querySelector("footer").offsetHeight;
  // Measure the notes at their own height, not stretched to the current window.
  notes.style.flex = "none";
  const content = notes.hidden ? 0 : notes.scrollHeight;
  notes.style.flex = "";
  api.resize(Math.ceil(fixed + content));
}

function setState({ phase, percent, message }) {
  const busy = phase === "downloading" || phase === "installing";
  progress.hidden = !busy;
  error.hidden = phase !== "error";
  if (phase === "error") error.textContent = message;
  const value = phase === "installing" ? 100 : Math.round(percent ?? 0);
  progress.firstElementChild.style.width = `${value}%`;
  progress.setAttribute("aria-valuenow", String(value));
  install.disabled = busy;
  install.textContent = phase === "downloading" ? `Downloading... ${value}%` : phase === "installing" ? "Installing..." : "Install and Restart";
  later.textContent = busy ? "Cancel" : "Later";
  later.disabled = phase === "installing";
}

install.addEventListener("click", () => api.install());
later.addEventListener("click", () => api.later());
addEventListener("keydown", (e) => { if (e.key === "Escape" && !later.disabled) api.later(); });
api.onState(setState);

(async () => {
  const info = await api.info();
  document.getElementById("version").textContent = `Vibecad ${info.version}`;
  const section = info.notes ? whatsNew(info.notes) : null;
  if (section) {
    notes.append(section);
    notes.hidden = false;
  }
  fit();
})();

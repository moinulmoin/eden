const announcer = document.querySelector<HTMLElement>("[data-announcer]");
const mobile = window.matchMedia("(max-width: 900px)");

function announce(message: string) {
  if (!announcer) return;
  announcer.textContent = "";
  window.setTimeout(() => (announcer.textContent = message), 30);
}

const storage = {
  get(key: string) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Private mode or blocked storage: the choice just isn't remembered.
    }
  },
};

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    announce("Copy failed. Select the command and copy it manually.");
    return false;
  }
}

const copyTimers = new WeakMap<HTMLElement, number>();

async function copyFrom(button: HTMLElement) {
  const text = button.dataset.copy;
  if (!text || !(await copyText(text))) return;
  const label = button.querySelector<HTMLElement>("[data-copy-label]");
  button.classList.add("is-copied");
  if (label) label.textContent = "Copied";
  announce(`Copied: ${text}`);
  window.clearTimeout(copyTimers.get(button));
  copyTimers.set(
    button,
    window.setTimeout(() => {
      button.classList.remove("is-copied");
      if (label) label.textContent = "Copy";
    }, 1600),
  );
}

document.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLElement>("[data-copy]");
  if (button) void copyFrom(button);
});

// Command rows: Enter copies the command.
for (const row of document.querySelectorAll<HTMLElement>("[data-copy-row]")) {
  row.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.target !== row) return;
    event.preventDefault();
    const button = row.querySelector<HTMLElement>("[data-copy]");
    if (button) void copyFrom(button);
  });
}

// Package manager tabs in the closing CTA.
const pm = document.querySelector<HTMLElement>("[data-pm]");
if (pm) {
  const tabs = [...pm.querySelectorAll<HTMLButtonElement>("[data-pm-tab]")];
  const text = pm.querySelector<HTMLElement>("[data-cmd-text]")!;
  const copy = pm.querySelector<HTMLElement>("[data-copy]")!;

  const select = (id: string, animate: boolean) => {
    const tab = tabs.find((item) => item.dataset.pmTab === id) ?? tabs[0]!;
    for (const item of tabs) {
      const active = item === tab;
      item.setAttribute("aria-selected", String(active));
      item.tabIndex = active ? 0 : -1;
    }
    const full = tab.dataset.command!;
    const shown = mobile.matches ? tab.dataset.short! : full;
    copy.dataset.copy = full;
    if (!animate) {
      text.textContent = shown;
      return;
    }
    text.classList.add("is-swapping");
    window.setTimeout(() => {
      text.textContent = shown;
      text.classList.remove("is-swapping");
    }, 180);
  };

  select(storage.get("eden:pm") ?? "npm", false);
  mobile.addEventListener("change", () => {
    const current = tabs.find((item) => item.getAttribute("aria-selected") === "true");
    select(current?.dataset.pmTab ?? "npm", false);
  });

  pm.addEventListener("click", (event) => {
    const tab = (event.target as Element).closest<HTMLButtonElement>("[data-pm-tab]");
    if (!tab) return;
    storage.set("eden:pm", tab.dataset.pmTab!);
    select(tab.dataset.pmTab!, true);
  });

  pm.addEventListener("keydown", (event) => {
    const index = tabs.findIndex((item) => item === document.activeElement);
    if (index < 0 || (event.key !== "ArrowRight" && event.key !== "ArrowLeft")) return;
    const next = tabs[(index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]!;
    next.focus();
    next.click();
  });
}

// Terminal: tabs switch between recorded runs, Replay replays the current one.
const term = document.querySelector<HTMLElement>("[data-term]");
if (term) {
  const tabs = [...term.querySelectorAll<HTMLButtonElement>("[data-term-tab]")];
  const runs = [...term.querySelectorAll<HTMLElement>("[data-term-run]")];

  const play = () => {
    term.classList.remove("is-playing");
    void term.offsetWidth;
    term.classList.add("is-playing");
  };

  const show = (id: string) => {
    for (const tab of tabs) {
      const active = tab.dataset.termTab === id;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    for (const run of runs) run.hidden = run.dataset.termRun !== id;
    play();
  };

  term.addEventListener("click", (event) => {
    const tab = (event.target as Element).closest<HTMLButtonElement>("[data-term-tab]");
    if (tab) show(tab.dataset.termTab!);
  });

  term.addEventListener("keydown", (event) => {
    const index = tabs.findIndex((item) => item === document.activeElement);
    if (index < 0 || (event.key !== "ArrowRight" && event.key !== "ArrowLeft")) return;
    const next = tabs[(index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]!;
    next.focus();
    show(next.dataset.termTab!);
  });

  document.querySelector("[data-replay]")?.addEventListener("click", play);

  const firstView = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        play();
        firstView.disconnect();
      }
    },
    { threshold: 0.35 },
  );
  firstView.observe(term);
}

// Scroll reveals.
const revealer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("is-in");
      revealer.unobserve(entry.target);
    }
  },
  { rootMargin: "0px 0px -8% 0px" },
);
for (const element of document.querySelectorAll("[data-reveal]")) revealer.observe(element);

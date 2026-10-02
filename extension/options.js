// See getSettings() in background.js for the stored settings
const destinationList = document.querySelector("#destinations");
const addCustomForm = document.querySelector("#add-custom");
const status = document.querySelector("#status");

let builtIns = [];
let settings = { hiddenKeywords: [], customDestinations: [], order: [] };

function showStatus(message, { error = false } = {}) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

async function save(changes) {
  settings = { ...settings, ...changes };
  await chrome.storage.sync.set(changes);
  showStatus("Saved");
  render();
}

// Alphanumeric keywords sort before others (e.g. `.`), then alphabetically.
// Built-in destinations follow this order by default
function compareKeywords(a, b) {
  const aIsAlphanumeric = /^[\da-z]/.test(a);
  const bIsAlphanumeric = /^[\da-z]/.test(b);
  if (aIsAlphanumeric !== bIsAlphanumeric) {
    return aIsAlphanumeric ? -1 : 1;
  }
  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
}

// Same as sortByOrder() in background.js: keywords in `order` (arranged by
// the user) come first, the rest keep their default position after them
function sortByOrder(items, order) {
  // Default positions: built-ins in their standard (alphabetical) order, with
  // each custom destination before the first keyword that sorts after it
  const defaultOrder = items.filter((item) => !item.custom);
  for (const custom of items
    .filter((item) => item.custom)
    .toSorted((a, b) => compareKeywords(a.keyword, b.keyword))) {
    const index = defaultOrder.findIndex(
      (item) => compareKeywords(item.keyword, custom.keyword) > 0,
    );
    defaultOrder.splice(index === -1 ? defaultOrder.length : index, 0, custom);
  }

  const rank = (keyword, index) => {
    const position = order.indexOf(keyword);
    return position === -1 ? order.length + index : position;
  };

  return defaultOrder
    .map((item, index) => ({ item, rank: rank(item.keyword, index) }))
    .toSorted((a, b) => a.rank - b.rank)
    .map(({ item }) => item);
}

/** Custom and built-in destinations in the order they are suggested */
function listEntries() {
  const customKeywords = new Set(
    settings.customDestinations.map(({ keyword }) => keyword),
  );

  return sortByOrder(
    [
      ...settings.customDestinations.map(({ keyword, label, urlTemplate }) => ({
        keyword,
        description: `${label} → ${urlTemplate}`,
        custom: true,
        replacesBuiltIn: builtIns.some(
          (builtIn) => builtIn.keyword === keyword,
        ),
      })),
      ...builtIns
        // A custom destination with the same keyword takes its place
        .filter(({ keyword }) => !customKeywords.has(keyword))
        .map(({ keyword, description }) => ({ keyword, description })),
    ],
    settings.order,
  );
}

function createButton(text, ariaLabel, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  if (ariaLabel) {
    button.ariaLabel = ariaLabel;
  }
  button.addEventListener("click", onClick);

  return button;
}

function createSpan(className, text) {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;

  return span;
}

function render() {
  const entries = listEntries();
  const keywords = entries.map(({ keyword }) => keyword);

  async function move(fromIndex, toIndex) {
    if (toIndex < 0 || toIndex >= keywords.length || toIndex === fromIndex) {
      return false;
    }
    const order = [...keywords];
    const [keyword] = order.splice(fromIndex, 1);
    order.splice(toIndex, 0, keyword);
    await save({ order });

    return true;
  }

  // Index of the row being dragged, so drop targets know what moves where
  let draggedIndex;

  destinationList.replaceChildren(
    ...entries.map(
      ({ keyword, description, custom, replacesBuiltIn }, index) => {
        const item = document.createElement("li");
        item.draggable = true;
        item.addEventListener("dragstart", (event) => {
          draggedIndex = index;
          event.dataTransfer.effectAllowed = "move";
          // Firefox only starts dragging when some data is set
          event.dataTransfer.setData("text/plain", keyword);
          item.classList.add("dragging");
        });
        item.addEventListener("dragend", () => {
          item.classList.remove("dragging");
        });
        item.addEventListener("dragover", (event) => {
          if (draggedIndex === undefined) {
            return;
          }
          event.preventDefault();
          item.classList.toggle("drop-before", draggedIndex > index);
          item.classList.toggle("drop-after", draggedIndex < index);
        });
        item.addEventListener("dragleave", () => {
          item.classList.remove("drop-before", "drop-after");
        });
        item.addEventListener("drop", (event) => {
          event.preventDefault();
          void move(draggedIndex, index);
          draggedIndex = undefined;
        });

        // A grip to drag by, which also moves the row with arrow keys
        const grip = createButton(
          "⋮⋮",
          `Reorder ${keyword} (arrow keys)`,
          () => {},
        );
        grip.className = "grip";
        grip.addEventListener("keydown", async (event) => {
          const offset = { ArrowUp: -1, ArrowDown: 1 }[event.key];
          if (offset === undefined) {
            return;
          }
          event.preventDefault();
          if (await move(index, index + offset)) {
            // The list has been re-rendered: keep focus on the moved row
            destinationList.querySelectorAll(".grip")[index + offset]?.focus();
          }
        });
        item.append(grip);

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = !settings.hiddenKeywords.includes(keyword);
        checkbox.ariaLabel = `Suggest ${keyword}`;
        checkbox.addEventListener("change", () => {
          const hiddenKeywords = settings.hiddenKeywords.filter(
            (hiddenKeyword) => hiddenKeyword !== keyword,
          );
          if (!checkbox.checked) {
            hiddenKeywords.push(keyword);
          }
          void save({ hiddenKeywords });
        });

        item.append(
          checkbox,
          createSpan("keyword", keyword),
          createSpan("description", description),
        );
        if (custom) {
          item.append(
            createSpan(
              "tag",
              replacesBuiltIn ? "custom, replaces built-in" : "custom",
            ),
          );
        }

        if (custom) {
          item.append(
            createButton("Delete", `Delete custom ${keyword}`, () => {
              void save({
                customDestinations: settings.customDestinations.filter(
                  (customDestination) => customDestination.keyword !== keyword,
                ),
                hiddenKeywords: settings.hiddenKeywords.filter(
                  (hiddenKeyword) => hiddenKeyword !== keyword,
                ),
                // A built-in destination with the same keyword takes its spot
                order: replacesBuiltIn
                  ? settings.order
                  : settings.order.filter(
                      (orderedKeyword) => orderedKeyword !== keyword,
                    ),
              });
            }),
          );
        }

        return item;
      },
    ),
  );
  if (builtIns.length === 0) {
    const note = document.createElement("li");
    note.className = "note";
    note.textContent = "Could not load built-in destinations from njt.";
    destinationList.prepend(note);
  }
}

document.querySelector("#reset-order").addEventListener("click", () => {
  void save({ order: [] });
});

document.querySelector("#reset-all").addEventListener("click", async () => {
  const customCount = settings.customDestinations.length;
  const confirmed = confirm(
    [
      "Reset all njt settings?",
      customCount > 0
        ? `This deletes ${customCount} custom destination${customCount === 1 ? "" : "s"}, restores the default order and shows all destinations again.`
        : "This restores the default order and shows all destinations again.",
      "This also applies to other browsers where you are signed in, and cannot be undone.",
    ].join("\n\n"),
  );
  if (!confirmed) {
    return;
  }

  await chrome.storage.sync.clear();
  settings = { hiddenKeywords: [], customDestinations: [], order: [] };
  render();
  showStatus("All settings have been reset");
});

document.querySelector("#fill-example").addEventListener("click", () => {
  addCustomForm.elements.keyword.value = "j";
  addCustomForm.elements.label.value = "jsdocs";
  addCustomForm.elements.urlTemplate.value =
    "https://www.jsdocs.io/package/{package}";
  showStatus("Example filled in: press Add to save it.");
  addCustomForm.elements.keyword.focus();
});

addCustomForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(addCustomForm);
  const keyword = String(data.get("keyword")).trim().toLowerCase();
  const label = String(data.get("label")).trim();
  const urlTemplate = String(data.get("urlTemplate")).trim();

  if (!/^[\w.-]{1,10}$/.test(keyword)) {
    showStatus(
      "Keywords are 1–10 letters, digits, dots, dashes or underscores.",
      { error: true },
    );
    return;
  }
  if (
    settings.customDestinations.some((custom) => custom.keyword === keyword)
  ) {
    showStatus(`There already is a custom destination for ${keyword}.`, {
      error: true,
    });
    return;
  }
  if (!/^https?:\/\//.test(urlTemplate) || !urlTemplate.includes("{package}")) {
    showStatus(
      "The URL needs to start with https:// (or http://) and contain {package}.",
      { error: true },
    );
    return;
  }

  // If the list is in alphabetical order, the new destination is slotted in
  // (by going back to the default order). Otherwise, it is added at the bottom
  const keywords = listEntries().map((entry) => entry.keyword);
  const isAlphabetical = keywords.every(
    (entryKeyword, index) =>
      index === 0 || compareKeywords(keywords[index - 1], entryKeyword) < 0,
  );

  addCustomForm.reset();
  void save({
    customDestinations: [
      ...settings.customDestinations,
      { keyword, label, urlTemplate },
    ],
    ...(isAlphabetical ? { order: [] } : {}),
  });
});

async function init() {
  const [stored, response] = await Promise.all([
    chrome.storage.sync.get(["hiddenKeywords", "customDestinations", "order"]),
    chrome.runtime.sendMessage({ type: "listDestinations" }),
  ]);
  settings = {
    hiddenKeywords: stored.hiddenKeywords ?? [],
    customDestinations: stored.customDestinations ?? [],
    order: stored.order ?? [],
  };
  builtIns = response?.destinations ?? [];
  render();
}

void init();

// See getSettings() in background.js for the stored settings
const builtInList = document.querySelector("#built-ins");
const customList = document.querySelector("#customs");
const addCustomForm = document.querySelector("#add-custom");
const status = document.querySelector("#status");

let builtIns = [];
let settings = { hiddenKeywords: [], customDestinations: [] };

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

function createItem(keyword, description, note) {
  const item = document.createElement("li");
  const keywordElement = document.createElement("span");
  keywordElement.className = "keyword";
  keywordElement.textContent = keyword;
  const descriptionElement = document.createElement("span");
  descriptionElement.className = "description";
  descriptionElement.textContent = description;
  item.append(keywordElement, descriptionElement);
  if (note) {
    const noteElement = document.createElement("span");
    noteElement.className = "note";
    noteElement.textContent = note;
    item.append(noteElement);
  }

  return item;
}

function render() {
  const customKeywords = new Set(
    settings.customDestinations.map(({ keyword }) => keyword),
  );

  builtInList.replaceChildren(
    ...builtIns.map(({ keyword, description }) => {
      const replaced = customKeywords.has(keyword);
      const item = createItem(
        keyword,
        description,
        replaced ? "replaced by a custom destination" : "",
      );
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = !settings.hiddenKeywords.includes(keyword);
      checkbox.disabled = replaced;
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
      item.prepend(checkbox);

      return item;
    }),
  );
  if (builtIns.length === 0) {
    builtInList.replaceChildren(
      createItem("", "Could not load destinations from njt.vercel.app."),
    );
  }

  customList.replaceChildren(
    ...settings.customDestinations.map(({ keyword, label, urlTemplate }) => {
      const item = createItem(keyword, `${label} → ${urlTemplate}`);
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.textContent = "Remove";
      removeButton.addEventListener("click", () => {
        void save({
          customDestinations: settings.customDestinations.filter(
            (custom) => custom.keyword !== keyword,
          ),
        });
      });
      item.append(removeButton);

      return item;
    }),
  );
}

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
      {
        error: true,
      },
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

  addCustomForm.reset();
  void save({
    customDestinations: [
      ...settings.customDestinations,
      { keyword, label, urlTemplate },
    ],
  });
});

async function init() {
  const [stored, response] = await Promise.all([
    chrome.storage.sync.get(["hiddenKeywords", "customDestinations"]),
    chrome.runtime.sendMessage({ type: "listDestinations" }),
  ]);
  settings = {
    hiddenKeywords: stored.hiddenKeywords ?? [],
    customDestinations: stored.customDestinations ?? [],
  };
  builtIns = response?.destinations ?? [];
  render();
}

void init();

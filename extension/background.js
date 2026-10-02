// Point this at http://localhost:3000 to try the extension against `pnpm dev`
const baseUrl = "https://njt.vercel.app";

const { version } = chrome.runtime.getManifest();

// Firefox differs from Chrome in a few omnibox details, see comments below.
// Checking for the `browser` global is not enough: recent Chrome defines it too.
const isFirefox = chrome.runtime.getURL("").startsWith("moz-extension:");

// Both browsers show 10 rows: the default one (describing Enter) + 9 suggestions
const maxSuggestionCount = 9;

// Chrome parses suggestion descriptions as XML, Firefox shows them as plain text
function escapeDescription(text) {
  return isFirefox
    ? text
    : text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}

const hint = "npm jump to: type a package name, then optionally a destination";

chrome.omnibox.setDefaultSuggestion({ description: hint });

// Stands out when skimming. Non-breaking spaces widen the gap around the frog,
// because Firefox may collapse regular ones
const gap = " ".repeat(4);
const moreSeparator = `${gap}🐸${gap}`;

/**
 * Preferences from the options page, synced across the user's browsers:
 * - hiddenKeywords: built-in destinations left out of suggestions (typing
 *   them still works)
 * - customDestinations: [{ keyword, label, urlTemplate }], resolved here
 *   rather than by njt.vercel.app, which must not redirect to arbitrary URLs
 * - order: keywords in the order the user arranged them
 */
async function getSettings() {
  const {
    hiddenKeywords = [],
    customDestinations = [],
    order = [],
  } = await chrome.storage.sync.get([
    "hiddenKeywords",
    "customDestinations",
    "order",
  ]);

  return { hiddenKeywords, customDestinations, order };
}

// Keywords in `order` come first, the rest keep their default position
// (custom destinations, then built-ins). Same as sortByOrder() in options.js
function sortByOrder(items, order) {
  const rank = (keyword, index) => {
    const position = order.indexOf(keyword);
    return position === -1 ? order.length + index : position;
  };

  return items
    .map((item, index) => ({ item, rank: rank(item.keyword, index) }))
    .toSorted((a, b) => a.rank - b.rank)
    .map(({ item }) => item);
}

function parseInput(text) {
  const [packageName = "", destination = ""] = text
    .split(" ")
    .filter((chunk) => chunk.length);

  return { packageName, destination: destination.toLowerCase() };
}

function findCustomDestination(destination, { customDestinations }) {
  return customDestinations.find(({ keyword }) => keyword === destination);
}

/** `/suggest` response → [{ keyword, completion, description, label }] */
function parseSuggestResponse([
  ,
  completions = [],
  descriptions = [],
  ,
  { "njt:labels": labels = [] } = {},
]) {
  return completions.map((completion, index) => ({
    keyword: completion.split(" ", 2)[1] ?? "",
    completion,
    description: descriptions[index] ?? "",
    label: labels[index] ?? "",
  }));
}

/**
 * Combines `/suggest` results with the user's settings into what the address
 * bar shows: a description of what Enter does (incl. destinations that do not
 * fit) and up to `maxSuggestionCount` rows. Pure, so it can be tested.
 */
function buildSuggestions(
  text,
  suggestResponse,
  settings,
  firefox = isFirefox,
) {
  const { packageName, destination } = parseInput(text);
  if (!packageName) {
    return undefined;
  }

  const [entered, ...builtIns] = parseSuggestResponse(suggestResponse);
  if (!entered) {
    return undefined;
  }

  const enteredCustom = findCustomDestination(destination, settings);
  const enteredRow = enteredCustom
    ? {
        completion: `${packageName} ${enteredCustom.keyword}`,
        description: enteredCustom.label,
      }
    : entered;

  const customKeywords = new Set(
    settings.customDestinations.map(({ keyword }) => keyword),
  );
  const candidates = sortByOrder(
    [
      ...settings.customDestinations
        .filter(
          ({ keyword }) =>
            keyword.startsWith(destination) &&
            keyword !== destination &&
            !settings.hiddenKeywords.includes(keyword),
        )
        .map(({ keyword, label }) => ({
          keyword,
          completion: `${packageName} ${keyword}`,
          description: label,
          label,
        })),
      ...builtIns.filter(
        ({ keyword }) =>
          !settings.hiddenKeywords.includes(keyword) &&
          // A custom destination with the same keyword replaces the built-in one
          !customKeywords.has(keyword),
      ),
    ],
    settings.order,
  );

  // In Firefox, the entered row takes one of the suggestion slots (see below)
  const shownCount = firefox ? maxSuggestionCount - 1 : maxSuggestionCount;
  const shown = candidates.slice(0, shownCount);
  const hidden = candidates.slice(shownCount);

  // Labels go last: if the row gets cut off, the keywords are still visible
  const hiddenLabels = hidden.map(({ label }) => label).filter(Boolean);
  const defaultDescription = escapeDescription(
    [
      `${enteredRow.completion} → ${enteredRow.description}`,
      ...(hidden.length > 0
        ? [
            `More: ${hidden.map(({ keyword }) => keyword).join(" ")}${
              hiddenLabels.length > 0 ? ` (${hiddenLabels.join(", ")})` : ""
            }`,
          ]
        : []),
    ].join(moreSeparator),
  );

  return {
    enteredCompletion: enteredRow.completion,
    defaultDescription,
    rows: shown.map(({ completion, description }) => ({
      content: completion,
      description: escapeDescription(`${completion} → ${description}`),
    })),
  };
}

/** Where entering the text goes: a custom destination or njt.vercel.app */
function resolveUrl(text, settings) {
  const { packageName, destination } = parseInput(text);
  const custom = findCustomDestination(destination, settings);
  if (custom && packageName) {
    return custom.urlTemplate.replaceAll("{package}", packageName);
  }

  return `${baseUrl}/jump?from=extension%40${version}&to=${encodeURIComponent(
    text,
  )}`;
}

async function fetchSuggestResponse(text, signal) {
  const response = await fetch(
    `${baseUrl}/suggest?q=${encodeURIComponent(text)}`,
    // Always revalidate, so a response cached before a deploy is not reused
    { signal, cache: "no-cache" },
  );

  return await response.json();
}

let pendingRequest;

chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
  pendingRequest?.abort();
  const request = new AbortController();
  pendingRequest = request;

  try {
    const [suggestResponse, settings] = await Promise.all([
      fetchSuggestResponse(text, request.signal),
      getSettings(),
    ]);
    const suggestions = buildSuggestions(text, suggestResponse, settings);
    if (!suggestions) {
      await chrome.omnibox.setDefaultSuggestion({ description: hint });
      suggest([]);
      return;
    }

    if (isFirefox) {
      // Firefox only applies a new default description on the next keystroke
      // (https://bugzil.la/1332942), so the entered row is a regular suggestion.
      // The trailing space stops Firefox from hiding it as identical to the input
      // and does not affect /jump.
      suggest([
        {
          content: `${suggestions.enteredCompletion} `,
          description: suggestions.defaultDescription,
        },
        ...suggestions.rows,
      ]);
    } else {
      // Awaiting avoids a race where Chrome keeps the previous default description
      await chrome.omnibox.setDefaultSuggestion({
        description: suggestions.defaultDescription,
      });
      suggest(suggestions.rows);
    }
  } catch {
    // Aborted by a newer keystroke or offline: entering the text still works
  }
});

chrome.omnibox.onInputEntered.addListener(async (text, disposition) => {
  const url = resolveUrl(text, await getSettings());

  switch (disposition) {
    case "newForegroundTab": {
      await chrome.tabs.create({ url });
      break;
    }
    case "newBackgroundTab": {
      await chrome.tabs.create({ url, active: false });
      break;
    }
    default: {
      await chrome.tabs.update({ url });
    }
  }
});

// The options page asks for the built-in destinations, so that `baseUrl` only
// lives in this file
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "listDestinations") {
    return false;
  }

  fetchSuggestResponse("package ")
    .then((suggestResponse) => {
      const [, ...builtIns] = parseSuggestResponse(suggestResponse);
      sendResponse({ destinations: builtIns });
    })
    .catch(() => {
      sendResponse({ destinations: [] });
    });

  // Keeps the channel open for the asynchronous response
  return true;
});

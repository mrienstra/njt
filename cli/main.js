import { readFileSync } from "node:fs";
import path from "node:path";

import open from "open";

// Point this at http://localhost:3000 to try the CLI against `pnpm dev`
const baseUrl = "https://njt.vercel.app";

export function getPackageVersion() {
  const filePath = new URL(import.meta.url).pathname;
  const packageJsonPath = path.resolve(path.dirname(filePath), "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

  return packageJson.version;
}

export function generateUrl(query) {
  return `${baseUrl}/jump?from=cli%40${getPackageVersion()}&to=${encodeURIComponent(
    query,
  )}`;
}

export async function openUrl(url, browser) {
  await open(url, { app: browser });
}

/**
 * Lists destinations for a package via /suggest. The first item describes
 * where the package name alone leads.
 */
export async function fetchDestinations(packageName) {
  const response = await fetch(
    `${baseUrl}/suggest?q=${encodeURIComponent(`${packageName} `)}`,
    { signal: AbortSignal.timeout(3000) },
  );
  const [, completions, descriptions, , { "njt:labels": labels = [] } = {}] =
    await response.json();

  return completions.map((completion, index) => ({
    keyword: completion.split(" ", 2)[1] ?? "",
    description: descriptions[index] ?? "",
    label: labels[index] ?? "",
  }));
}

export function generateZshCompletionScript() {
  return `#compdef njt
# zsh completion for njt (https://njt.vercel.app)
# Enable it by adding this line to ~/.zshrc:
#   eval "$(njt --completion zsh)"

_njt_destinations() {
  local -a lines keywords labels descriptions displays expl
  local line rest keyword i width=0 fullWidth=0
  # Calls njt itself (or whatever $words[1] is, e.g. a function wrapping it)
  lines=("\${(@f)$("$words[1]" --complete-destination "$1" 2>/dev/null)}")
  for line in "\${(@)lines[2,-1]}"; do
    keyword=\${line%%:*}
    rest=\${line#*:}
    keywords+=("$keyword")
    labels+=("\${rest%%:*}")
    descriptions+=("\${rest#*:}")
    if (( $#keyword > width )); then
      width=$#keyword
    fi
  done
  if (( ! $#keywords )); then
    _message 'destination (could not load suggestions)'
    return
  fi

  # Layout, based on the matches left after narrowing (e.g. \`p\` -> p, pp):
  # 1. full descriptions in two columns, if they fit the width
  # 2. full descriptions one per line, if they fit the height (and width)
  # 3. short labels, in as many columns as fit
  local matchCount=0
  for i in {1..$#keywords}; do
    if [[ $keywords[i] == $PREFIX* ]]; then
      (( matchCount++ ))
      if (( width + 4 + $#descriptions[i] > fullWidth )); then
        fullWidth=$(( width + 4 + $#descriptions[i] ))
      fi
    fi
  done
  if (( 2 * (fullWidth + 2) > COLUMNS )); then
    if (( matchCount + 2 > LINES || fullWidth > COLUMNS )); then
      descriptions=("\${(@)labels}")
    fi
  fi

  # Unlike _describe, which puts each match on its own line, plain display
  # strings let zsh use columns when the terminal is wide enough
  for i in {1..$#keywords}; do
    displays+=("\${(r:width:)keywords[i]} -- $descriptions[i]")
  done
  _description destinations expl "destination (none: $lines[1])"
  compadd "\${(@)expl}" -d displays -- "\${(@)keywords}"
}

_njt() {
  if (( CURRENT == 3 )); then
    _njt_destinations "$words[2]"
  elif (( CURRENT == 2 )); then
    if [[ -z $PREFIX || -n $SUFFIX ]]; then
      _message 'package name (or . for the nearest package.json)'
    else
      # \`njt prettier<Tab>\` acts like \`njt prettier <Tab>\`: the package name and
      # a space become an already-typed prefix, followed by the destinations
      local package=$PREFIX
      IPREFIX+="$package "
      PREFIX=
      _njt_destinations "$package"
      # zsh either inserts the space or lists matches; this makes it do both
      compstate[list]='list force'
    fi
  fi
}

if (( ! $+functions[compdef] )); then
  autoload -Uz compinit
  compinit
fi
compdef _njt njt
`;
}

/**
 * Prints destinations in the format the zsh completion script expects: a
 * header line, then `keyword:label:description` lines
 */
export async function printDestinationCompletions(packageName, log) {
  try {
    const [entered, ...destinations] = await fetchDestinations(packageName);
    log(entered?.description ?? "");
    for (const { keyword, label, description } of destinations) {
      log(`${keyword}:${label}:${description}`);
    }
  } catch {
    // Offline or timed out: no suggestions, the shell shows a message instead
  }
}

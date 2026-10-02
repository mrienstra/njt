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
  const [, completions, descriptions] = await response.json();

  return completions.map((completion, index) => ({
    keyword: completion.split(" ", 2)[1] ?? "",
    description: descriptions[index] ?? "",
  }));
}

export function generateZshCompletionScript() {
  return `#compdef njt
# zsh completion for njt (https://njt.vercel.app)
# Enable it by adding this line to ~/.zshrc:
#   eval "$(njt --completion zsh)"

_njt() {
  if (( CURRENT == 2 )); then
    _message 'package name (or . for the nearest package.json)'
  elif (( CURRENT == 3 )); then
    local -a lines destinations
    # Calls njt itself (or whatever $words[1] is, e.g. a function wrapping it)
    lines=("\${(@f)$("$words[1]" --complete-destination "$words[2]" 2>/dev/null)}")
    destinations=("\${(@)lines[2,-1]}")
    if (( $#destinations )); then
      _describe -t destinations "destination (none: $lines[1])" destinations
    else
      _message 'destination (could not load suggestions)'
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
 * header line, then `keyword:description` lines
 */
export async function printDestinationCompletions(packageName, log) {
  try {
    const [entered, ...destinations] = await fetchDestinations(packageName);
    log(entered?.description ?? "");
    for (const { keyword, description } of destinations) {
      log(`${keyword.replaceAll(":", String.raw`\:`)}:${description}`);
    }
  } catch {
    // Offline or timed out: no suggestions, the shell shows a message instead
  }
}

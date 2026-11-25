const PC_SCOPE = /^(?:On PC|In the (?:reviewed )?PC (?:version|build)),|(?<!than )(?<!as )(?<!like )(?<!not )\bon PC$/i;
const SWITCH_2_SCOPE = /^(?:On (?:the )?(?:Nintendo )?Switch 2(?: (?:port|version))?,|The (?:Nintendo )?Switch 2 (?:port|version)\b)|(?<!than )(?<!as )(?<!like )(?<!not )\bon (?:the )?(?:Nintendo )?Switch 2(?: (?:port|version))?$/i;
const EARLY_ACCESS_SCOPE = /^(?:In |During |The )?Early Access\b|\b(?:in|during) (?:the )?Early Access(?: (?:build|version))?$/i;
const DAY_ZERO_SCOPE = /^(PC, )?((?:\d+\s?GB )?Day[- ]0 patch)(, PC)?$/i;

// Format the explicit qualifier on a saved finding. Leave unfamiliar qualifier
// lists and composite findings intact, since their scope may apply to only one clause.
export function presentMediaFindingText(text: string): string {
  if (text.includes(" / ")) return text;

  const suffix = /^(.+) \(([^()]+)\)([.!?]?)$/.exec(text);
  if (!suffix) {
    return text.replace(
      /^On the ((?:\d+\s?GB )?Day[- ]0 patch) PC build,/i,
      "On PC with the $1,",
    );
  }

  const [, body, qualifier, punctuation] = suffix;
  if (/[.!?]$/.test(body)) return text;

  const dayZero = DAY_ZERO_SCOPE.exec(qualifier);
  if (dayZero) {
    const platform = (dayZero[1] || dayZero[3]) && !PC_SCOPE.test(body) ? " on PC" : "";
    return `${body}${platform} with the ${dayZero[2]}${punctuation}`;
  }

  const reviewedPC = /^reviewed PC (version|build)$/i.exec(qualifier);
  if (reviewedPC) {
    const scope = PC_SCOPE.test(body) ? "" : ` in the reviewed PC ${reviewedPC[1].toLowerCase()}`;
    return `${body}${scope}${punctuation}`;
  }

  if (/^(?:on the )?(?:Nintendo )?Switch 2(?: (?:port|version))?$/i.test(qualifier)) {
    if (SWITCH_2_SCOPE.test(body)) return body + punctuation;
    const platform = qualifier.replace(/^on the /i, "");
    const article = /(?:port|version)$/i.test(platform) ? "the " : "";
    return `${body} on ${article}${platform}${punctuation}`;
  }

  if (/^Early Access$/i.test(qualifier)) {
    const scope = EARLY_ACCESS_SCOPE.test(body) ? "" : " in Early Access";
    return `${body}${scope}${punctuation}`;
  }

  return text;
}

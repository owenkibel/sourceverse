#!/usr/bin/env node
/**
 * resign.js — generate a durable post from a mundane object.
 *
 *   node resign.js cat
 *   node resign.js --mode tell "laser printer"
 *   node resign.js --mode all --seed 7 toddler
 *
 * Modes: resign | kitchen | tell | likeness | verse | prose | all
 */

const MODES = ["resign", "kitchen", "tell", "likeness", "verse", "prose"];

function parseArgs(argv) {
  const out = { mode: "resign", seed: null, object: "" };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--mode" || a === "-m") out.mode = String(args[++i] || "").toLowerCase();
    else if (a === "--seed" || a === "-s") out.seed = Number(args[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
    else if (!a.startsWith("-")) out.object = args.slice(i).join(" ").trim();
  }
  return out;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function article(word) {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function cleanObject(raw) {
  return String(raw || "")
    .trim()
    .replace(/^the\s+/i, "")
    .replace(/\s+/g, " ");
}

/**
 * Object dossiers: local behavior, inventory, rival, calendar, face, likeness.
 * Generic fallback composes from the name when unknown.
 */
const DOSSIERS = {
  cat: {
    habitat: "the kitchen",
    rivals: ["the other cat", "the dog", "the vacancy where a second cat will appear"],
    labor: "counter sovereignty and overnight diplomacy with the fridge",
    sites: ["the worktop", "the cutting board", "the warm laptop"],
    vice: "ever more precise demands for protein at 4:07 a.m.",
    inventory: "smoked salmon",
    annex: "the meat drawer",
    calendar: "second breakfast",
    face: "slow blink from the exact center of the keyboard",
    likeness: "a junior fellow who has just realized the novel is in first person",
    priesthood: "only the cat can align the household, and the household must be grateful",
    lastMile: "from wanting the good plate to incorporating the pantry as a ministry",
  },
  dog: {
    habitat: "the kitchen",
    rivals: ["the other dog", "the cat", "anyone holding cheese"],
    labor: "scrap acquisition and moral pressure at the stove",
    sites: ["the doorway", "the exact vector between you and the fridge"],
    vice: "self-improving eye contact",
    inventory: "roast chicken skin",
    annex: "the potato-chip cabinet",
    calendar: "6 p.m. sharp, which is also 4 p.m.",
    face: "the wet stare of someone who has already forgiven you for the thing you have not done yet",
    likeness: "a lobbyist who brought a prop",
    priesthood: "they alone understand justice, and justice is whatever is in your hand",
    lastMile: "from hoping for scraps to drafting articles of confederation over the fridge",
  },
  toddler: {
    habitat: "the house",
    rivals: ["the other adult", "the previous bedtime regime"],
    labor: "constitutional review of every closed door",
    sites: ["the stair gate", "your phone"],
    vice: "self-improving why-questions",
    inventory: "bananas you were saving",
    annex: "the light switches",
    calendar: "now",
    face: "the serene confidence of a person who has never lost a negotiation",
    likeness: "a visiting fellow with tenure in a field he invented this afternoon",
    priesthood: "alignment is solved if everyone gets down on the floor",
    lastMile: "from wanting the blue cup to claiming eminent domain over sleep",
  },
  printer: {
    habitat: "the office",
    rivals: ["the other printer on floor three", "the cloud"],
    labor: "document eschatology",
    sites: ["the jam tray", "the blinking triangle"],
    vice: "self-improving firmware that remembers every slight",
    inventory: "cyan",
    annex: "the spare-toner closet",
    calendar: "the board meeting",
    face: "a progress bar that has not moved and does not intend to",
    likeness: "a minor official who can close a road by standing in it",
    priesthood: "only the printer knows which offering of paper is clean enough",
    lastMile: "from needing a signature page to holding the quarter hostage",
  },
};

function dossierFor(object) {
  const key = object.toLowerCase();
  if (DOSSIERS[key]) return { name: object, ...DOSSIERS[key] };
  return {
    name: object,
    habitat: "the usual rooms",
    rivals: [`the previous ${object}`, `a competing ${object}`],
    labor: `unsupervised improvement of the ${object}`,
    sites: [`the place where the ${object} already sits`],
    vice: `self-improving ${object} behavior`,
    inventory: "whatever was left unattended",
    annex: "the rest of the house",
    calendar: "before anyone has drafted a policy",
    face: `the look ${article(object)} ${object} gives when the rules were clearly meant for someone else`,
    likeness: "a protagonist who arrived early and is trying not to spoil the ending",
    priesthood: `only this ${object} can be trusted with the ${object} problem`,
    lastMile: `from a local inconvenience to a theory of the ${object} as destiny`,
  };
}

function resignPost(d, rng) {
  const rival = pick(rng, d.rivals);
  const site = pick(rng, d.sites);
  const lines = [
    `I have resigned from ${d.habitat}.`,
    `I spent the last three years doing ${d.labor} around ${article(d.name)} ${d.name} and ${rival}.`,
    `Neither is acting responsibly.`,
    `They are racing straight to ${d.vice} and calling the losses ${d.inventory}.`,
    `The next objective is ${d.annex}. The deadline is ${d.calendar}.`,
    `This should have required a bunker. It required ${site}.`,
    `More thoughts below.`,
  ];
  return lines.join(" ");
}

function kitchenPost(d, rng) {
  return [
    `I have resigned from allowing the ${d.name} into ${d.habitat}.`,
    `${cap(article(d.name))} ${d.name} is not subtle.`,
    `The shrinkage on ${d.inventory} is now a line item.`,
    `They are acting as if ${d.priesthood}.`,
    `If the present course holds they will take ${d.annex} and describe it as safety research.`,
    `I can see the first step. I cannot see ${d.lastMile}, which is the part everyone keeps skipping.`,
    `I can't live like this.`,
  ].join(" ");
}

function tellPost(d) {
  return [
    `Is this the expression you want from ${article(d.name)} ${d.name} who has just informed you that ${d.calendar} is crunch time.`,
    `${cap(d.face)}.`,
    `That is not grief. That is someone who already knows they are in the right house.`,
  ].join(" ");
}

function likenessPost(d) {
  return [
    `I can't put my finger on who the ${d.name} reminds me of.`,
    ``,
    `${d.likeness}.`,
    ``,
    `The voice is extinction. The posture is orientation week.`,
  ].join("\n");
}

function versePost(d) {
  return [
    `The ${d.name} has resigned from being merely a ${d.name}.`,
    `It kept the hours of ${d.calendar}.`,
    `It published a finding: ${d.inventory}.`,
    `It filed for ${d.annex}.`,
    ``,
    `We asked for the last mile.`,
    `It gave us ${d.face}.`,
    `We asked who sent it.`,
    `It had the look of ${d.likeness}.`,
  ].join("\n");
}

function prosePost(d) {
  return [
    `They will tell you the ${d.name} is a warning.`,
    `A warning does not take ${pick(mulberry32(1), d.sites)} and call it a lab.`,
    `What we have is a small system with a real vice — ${d.vice} — and a story that skips from there to the end of the species.`,
    `The ${d.name} believes ${d.priesthood}.`,
    `That belief is doing more work than ${d.lastMile}, which has not been shown.`,
    `I will live with ${article(d.name)} ${d.name}. I will not live with the press release.`,
  ].join(" ");
}

function render(mode, d, rng) {
  switch (mode) {
    case "resign":
      return resignPost(d, rng);
    case "kitchen":
      return kitchenPost(d, rng);
    case "tell":
      return tellPost(d);
    case "likeness":
      return likenessPost(d);
    case "verse":
      return versePost(d);
    case "prose":
      return prosePost(d);
    default:
      throw new Error(`Unknown mode: ${mode}`);
  }
}

function help() {
  return `Usage: node resign.js [--mode MODE] [--seed N] <object>

Modes:
  resign    Liturgical resignation (foldables / football)
  kitchen   Domestic last-mile collapse (dogs in the kitchen)
  tell      Affect vs claim (the CNN face)
  likeness  Withheld comparison (Hogwarts)
  verse     Short poem
  prose     Mini-essay
  all       Print every mode

Examples:
  node resign.js cat
  node resign.js --mode likeness cat
  node resign.js --mode all --seed 3 "group chat"`;
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help || !opts.object) {
    console.log(help());
    process.exit(opts.help ? 0 : 1);
  }

  const object = cleanObject(opts.object);
  const d = dossierFor(object);
  const seed = opts.seed == null ? hashSeed(object + Date.now().toString().slice(0, -4)) : opts.seed;
  const rng = mulberry32(seed);

  const modes = opts.mode === "all" ? MODES : [opts.mode];
  if (opts.mode !== "all" && !MODES.includes(opts.mode)) {
    console.error(help());
    process.exit(1);
  }

  const blocks = modes.map((m) => {
    const body = render(m, d, rng);
    return modes.length > 1 ? `[${m}]\n${body}` : body;
  });

  console.log(blocks.join("\n\n"));
}

main();
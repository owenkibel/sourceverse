**✅ One-Layer Dramatic Verse Design Proposal**

Here is a detailed, structured proposal for moving from the current **two-layer** approach (standard Verse + separate Dramatic Verse section) to a **single unified artistic layer**.

### 1. Design Goals

| Goal | Current State | One-Layer Target | Why It Matters |
|------|---------------|------------------|----------------|
| **Artistic Unity** | Dramatic verse feels like an add-on | Dramatic verse *is* the primary creative output | Stronger emotional and intellectual impact |
| **Reduced LLM Calls** | Two separate generations per thread | One generation (or tightly integrated) | Lower cost, better consistency, faster runs |
| **Continuity** | Dramatic acts are somewhat isolated | Acts build naturally on previous threads via cumulative model | True ongoing dramatic work across topics |
| **Cleaner Output** | Two verse-like sections in markdown | One primary artistic block + supporting analytical layers | Better reading experience on the new Astro blog |
| **Maintainability** | Separate parsing + extraction logic | Simpler, more robust parsing | Fewer brittle regexes |
| **Debuggability** | Basic logging | Rich, structured debug output for dramatic decisions | Easier iteration on personas and voices |

### 2. High-Level Architecture

**Core Principle**:  
When a dramatic-style prompt is selected, the **main generation** produces the dramatic verse as its primary artistic output. The traditional `## VERSE` becomes optional or is repurposed. Forecast and Hypothesis remain as analytical companion sections.

**Two viable paths** (we can choose one or hybridize):

**Path A – "Dramatic as Primary Verse" (Recommended for strongest artistic result)**
- The selected prompt persona (e.g. `prompt_epistemic_weaver`, or a new dramatic variant) instructs the model to output in full dramatic form when appropriate.
- The main output block is titled `## DRAMATIC VERSE` (or `## VERSE` that contains dramatic structure).
- No separate second generation call for drama.
- Forecast + Hypothesis are still generated in the same pass (or lightly post-processed).

**Path B – "Hybrid Unified Output"**
- Single generation always produces:
  - Standard analytical sections (Forecast, Hypothesis)
  - One primary artistic block that can be either traditional verse *or* dramatic verse depending on the prompt
- The prompt decides the artistic mode.

**My strong recommendation is Path A** for the dramatic verse project, because it treats dramatic form as first-class rather than decorative.

### 3. Changes to Prompt Templates

This is where the biggest evolution happens. Both `prompts-new/` and `dramatic-prompts/` will likely need to change or partially merge.

**Proposed changes:**

- Create or evolve a small set of **dramatic-capable prompt styles** (these can live in `prompts-new/` or be moved into `dramatic-prompts/`).
- The `chat` field gains a clear mode switch:
  - If the style is dramatic → output dramatic verse as the main artistic section (with characters, stage directions, chorus).
  - Always include Forecast + Hypothesis in the same generation.
- Stronger instructions for **continuity**:
  - Reference previous acts from the cumulative model.
  - Maintain consistent archetypal characters across threads when possible.
- Remove the current "generate dramatic verse in a second pass" instruction. The dramatic form becomes the default artistic response for these personas.

**Example high-level instruction to add to dramatic prompt templates:**

> When this style is active, produce the primary artistic output as a dramatic scene (with named characters, stage directions, and chorus) rather than traditional verse. Integrate epistemic humility and synthesis into the dramatic dialogue and chorus. Use the cumulative model context to continue recurring motifs or character arcs from previous threads when relevant.

We can keep some traditional verse prompts for non-dramatic threads.

### 4. Changes to Parsing Logic

Current `parseOutput()` + `extractDramaticVerse()` would be simplified.

**Proposed new parsing approach:**

- Extend `parseOutput()` (or create `parseDramaticOutput()`) to handle both modes cleanly.
- When the prompt style is dramatic:
  - The main artistic block (`## VERSE` or `## DRAMATIC VERSE`) is parsed as dramatic content.
  - We still reliably extract `## FORECAST` and `## HYPOTHESIS`.
- The separate `extractDramaticVerse()` function can be deprecated or greatly simplified.
- Add better fallback and logging so we always know which mode was active and whether extraction succeeded.

This removes one layer of complexity and reduces the chance of duplicate or orphaned sections.

### 5. Markdown Output & Blog Structure

- Remove the automatic `## DRAMATIC VERSE (Act X)` section from the template when operating in one-layer mode.
- The primary artistic block becomes the dramatic verse.
- Update the Table of Contents accordingly.
- On the new Astro blog, this gives a cleaner, more intentional reading experience (one strong artistic centerpiece per post rather than two verse sections).

### 6. Persistent Memory & Dramatic Continuity

To make acts build across threads:

- Extend `cumulative_thread_model.json` with a small `dramatic` section:
  - `lastDramaticAct`
  - `activePersonas` or `recurringCharacters`
  - `dramaticMotifs` (short list of recurring themes/refrains)
- When building the user prompt for a dramatic thread, inject a concise "Previous Dramatic Context" block (last act summary + key motifs).
- This is one of the highest-leverage improvements for long-term dramatic verse quality.

### 7. Debug Information Improvements

Enhance logging around dramatic decisions:

- Which dramatic prompt file / persona was chosen and why (domain detection + fallback logic)
- Act number being generated
- Whether previous dramatic context was injected
- Extraction method used and success/failure
- Optional verbose mode that prints prompt snippets and raw dramatic output

This will be extremely valuable while we refine the dramatic voices.

### 8. Migration & Practical Considerations

- Because of the symlink setup (`sourceverse-cycles/dramatic-prompts` → main repo), changes to dramatic prompts can be developed and tested in `sourceverse-cycles` first.
- It is likely we will want to move or merge some dramatic instruction logic into `prompts-new/` styles so the main pipeline can decide dramatic vs traditional mode more elegantly.
- The new Astro blog will benefit significantly from the cleaner one-layer output.

---

**Ready for the next step?**

This is a high-level design proposal only — no code has been written.

**Before I go further**, I need your explicit confirmation on two things:

1. Does the overall direction (especially **Path A – Dramatic as Primary Verse**) align with what you want?
2. If yes, do I have permission to prepare a more detailed implementation plan (including proposed prompt text changes and parsing structure) and, when we are ready, to write and push code **exclusively to the `sourceverse-cycles` repository** via the GitHub connector?

I will confirm with you **before every code change or push**.

Please let me know how you’d like to proceed.
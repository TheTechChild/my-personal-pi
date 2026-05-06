/**
 * FilterableList: a small reusable Component that pairs a text input with a
 * SettingsList and routes input based on which zone is focused.
 *
 * Why we built this instead of using SettingsList's built-in `enableSearch`:
 * SettingsList's search routes every printable character to the filter input
 * unconditionally. That made plain letter-keys (`r`, `t`, etc.) unusable as
 * action shortcuts in the panel because they'd collide with filter input.
 *
 * The model here is the same focus paradigm as fzf, command palettes, etc.:
 *   - When the input is focused, all keys go to the input. Down arrow moves
 *     focus to the list.
 *   - When the list is focused, arrows navigate. Letter keys are free for
 *     panel-level shortcuts. Up arrow at row 0 moves focus to the input.
 *
 * Filter behavior: as the user types, items are filtered by fuzzy-matching
 * the user-supplied label. Filtered items are sorted alphabetically by
 * label (NOT by fuzzy match score) — preserving "the list looks the same
 * just smaller" feel.
 *
 * Esc semantics:
 *   - With filter input focused and non-empty: Esc clears the filter.
 *   - With filter input focused and empty: Esc closes the panel (via
 *     onCancel callback).
 *   - With list focused: Esc closes the panel.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import {
  type Component,
  type Focusable,
  Input,
  type SettingItem,
  SettingsList,
  fuzzyFilter,
  matchesKey,
} from "@mariozechner/pi-tui";

export type FilterableListZone = "input" | "list";

export interface FilterableListOptions {
  /** Items to display. The list is rebuilt internally whenever this changes. */
  items: SettingItem[];
  /** pi theme for input border styling. */
  theme: Theme;
  /** Hint text to show below the filter when input is focused but empty. */
  filterPlaceholder?: string;
  /**
   * Maximum visible rows in the SettingsList. Defaults to a reasonable size
   * based on item count.
   */
  maxVisible?: number;
  /** Called when the user activates a row (Enter / Space). */
  onSelect?: (id: string) => void;
  /** Called when the user wants to close the whole panel (Esc on empty input or list). */
  onCancel: () => void;
  /** Called when SettingsList's onChange fires (e.g. for cyclable values). */
  onValueChange?: (id: string, newValue: string) => void;
}

export class FilterableList implements Component, Focusable {
  private theme: Theme;
  private filterPlaceholder: string;
  private input: Input;
  private list: SettingsList;
  private allItems: SettingItem[];
  private filtered: SettingItem[];
  private zone: FilterableListZone = "list";
  private _focused = false;
  private maxVisible: number;
  private onCancel: () => void;
  private onListSelectInternal: () => void; // SettingsList onCancel hook

  constructor(opts: FilterableListOptions) {
    this.theme = opts.theme;
    this.filterPlaceholder = opts.filterPlaceholder ?? "Type to filter…";
    this.maxVisible = opts.maxVisible ?? Math.min(Math.max(opts.items.length + 2, 8), 24);
    this.onCancel = opts.onCancel;

    this.input = new Input();
    this.input.onEscape = () => {
      // Esc on a non-empty input clears it; on an empty input, close.
      if (this.input.getValue().length > 0) {
        this.input.setValue("");
        this.applyFilter();
      } else {
        this.onCancel();
      }
    };

    this.allItems = opts.items;
    this.filtered = sortAlpha(opts.items);

    // SettingsList hands us its own onCancel; we route it to the panel cancel.
    this.onListSelectInternal = () => this.onCancel();
    this.list = this.buildList(opts);
  }

  // ---------- Focusable ----------

  /**
   * The whole panel either has focus or it doesn't (set by pi when the
   * overlay opens). Internally, `zone` decides where the cursor goes when
   * we DO have focus. We treat focus from pi as "overlay is open" rather
   * than gating cursor visibility on it — because the user navigates
   * between deeply-nested FilterableList instances (e.g. the tool submenu
   * inside the server detail), and pi only marks the outermost component
   * focused. Forwarding focus through every Container in the chain just
   * to make a nested input show its cursor would be brittle.
   */
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    if (!value) this.input.focused = false;
    else this.input.focused = this.zone === "input";
  }

  // ---------- Zone management ----------

  /** Programmatically move focus between input and list. */
  setZone(zone: FilterableListZone): void {
    if (this.zone === zone) return;
    this.zone = zone;
    // Update the Input's focused flag based on the new zone. We don't gate
    // on `_focused` here because `_focused` only reflects what pi said
    // about the outermost overlay component; nested FilterableLists never
    // get a focus signal from pi but still need their input to show a
    // cursor when they're the active zone of the visible UI.
    this.input.focused = zone === "input";
  }

  getZone(): FilterableListZone {
    return this.zone;
  }

  // ---------- Items ----------

  /**
   * Replace the underlying items. Preserves zone, filter text, and
   * (best-effort) cursor.
   *
   * **Submenu safety:** if the list currently has an open submenu (drilled-
   * in detail view), `setItems` is a no-op. Mutating the items array would
   * be safe, but rebuilding the SettingsList would close the submenu by
   * destroying its `submenuComponent` reference. Callers should consult
   * `hasOpenSubmenu()` separately if they need to know whether their
   * update was applied.
   */
  setItems(items: SettingItem[]): void {
    if (this.hasOpenSubmenu()) {
      // Stash the new items so a future call (after the submenu closes)
      // can pick them up without losing data. We keep `allItems` updated;
      // the rebuild happens on the next setItems call once the submenu is
      // gone.
      this.allItems = items;
      return;
    }
    const previouslySelected = this.getSelectedId();
    this.allItems = items;
    this.applyFilter();
    if (previouslySelected) this.setSelectedId(previouslySelected);
  }

  /** Current filter text. */
  getFilter(): string {
    return this.input.getValue();
  }

  /** Restore filter text and rebuild filtered rows. */
  setFilter(value: string): void {
    this.input.setValue(value);
    this.applyFilter();
  }

  /** Move the cursor onto the row whose id matches; no-op if not found. */
  setSelectedId(id: string): void {
    const internal = this.list as unknown as {
      selectedIndex?: number;
      filteredItems?: SettingItem[];
      items?: SettingItem[];
    };
    const arr = internal.filteredItems ?? internal.items;
    if (!arr) return;
    const idx = arr.findIndex((it) => it.id === id);
    if (idx >= 0) internal.selectedIndex = idx;
  }

  /**
   * Update one row's right-side `currentValue` without rebuilding the list.
   * Cheap: doesn't move the cursor or affect filter ordering.
   */
  updateValue(id: string, newValue: string): void {
    const item = this.allItems.find((it) => it.id === id);
    if (item) item.currentValue = newValue;
    this.list.updateValue(id, newValue);
  }

  /** Get the id of the currently-selected row in the (filtered) list, if any. */
  getSelectedId(): string | undefined {
    const internal = this.list as unknown as {
      selectedIndex?: number;
      filteredItems?: SettingItem[];
      items?: SettingItem[];
    };
    const arr = internal.filteredItems ?? internal.items;
    const idx = internal.selectedIndex;
    if (typeof idx !== "number" || !arr) return undefined;
    return arr[idx]?.id;
  }

  /** True if the list currently has an open submenu (drilldown). */
  hasOpenSubmenu(): boolean {
    return Boolean((this.list as unknown as { submenuComponent?: unknown }).submenuComponent);
  }

  // ---------- Component ----------

  invalidate(): void {
    this.input.invalidate();
    this.list.invalidate();
  }

  render(width: number): string[] {
    // When the SettingsList has an active submenu, it renders the submenu
    // in place of its main list. We need to hide our filter input row in
    // that case — otherwise the parent's filter shows above each nested
    // submenu, which is visually noisy and misleading (the user can't
    // type into a filter that doesn't apply to what they're looking at).
    if (this.hasOpenSubmenu()) {
      return this.list.render(width);
    }
    const lines: string[] = [];
    lines.push(...this.renderInput(width));
    lines.push(""); // gap
    lines.push(...this.list.render(width));
    return lines;
  }

  handleInput(data: string): void {
    // Submenu always wins.
    if (this.hasOpenSubmenu()) {
      this.list.handleInput(data);
      return;
    }

    // Switch zones at boundaries. Use matchesKey rather than raw escape
    // comparisons so we work across legacy + Kitty keyboard protocols and
    // any modifiers the terminal might send.
    if (this.zone === "input") {
      // Down arrow at the input → focus the list.
      if (matchesKey(data, "down")) {
        this.setZone("list");
        return;
      }
      // Otherwise, the input handles everything (typing, Esc, navigation
      // within the text, paste, etc.). After any change, re-apply filter.
      const before = this.input.getValue();
      this.input.handleInput(data);
      if (this.input.getValue() !== before) this.applyFilter();
      return;
    }

    // zone === "list"
    if (matchesKey(data, "up")) {
      // Up at the top row of the list → move focus to the input. If we're
      // not at the top row, fall through and let SettingsList handle the
      // cursor move.
      const internal = this.list as unknown as { selectedIndex?: number };
      if (internal.selectedIndex === 0) {
        this.setZone("input");
        return;
      }
    }
    this.list.handleInput(data);
  }

  // ---------- Internals ----------

  private buildList(opts: FilterableListOptions): SettingsList {
    return new SettingsList(
      this.filtered,
      this.maxVisible,
      getSettingsListTheme(),
      (id, newValue) => {
        opts.onValueChange?.(id, newValue);
      },
      this.onListSelectInternal,
      // We provide our own filter; turn off the built-in one so the
      // SettingsList doesn't intercept letter keys.
      { enableSearch: false },
    );
  }

  private applyFilter(): void {
    const query = this.input.getValue().trim();
    if (query.length === 0) {
      this.filtered = sortAlpha(this.allItems);
    } else {
      // Use fuzzyFilter to filter, but re-sort alphabetically. The library
      // sorts by score; we want stable alphabetical order regardless.
      const matched = fuzzyFilter(this.allItems, query, (it) => it.label);
      this.filtered = sortAlpha(matched);
    }
    // Mutate the SettingsList's internal items array in place. SettingsList
    // doesn't expose a `setItems` API, so we reach into its private fields.
    const internal = this.list as unknown as {
      items?: SettingItem[];
      filteredItems?: SettingItem[];
      selectedIndex?: number;
    };
    internal.items = this.filtered;
    internal.filteredItems = this.filtered;
    internal.selectedIndex = 0;
  }

  private renderInput(width: number): string[] {
    // Visually-focused = our input zone is active. We don't gate on the
    // `_focused` flag from pi because nested FilterableLists never receive
    // a focus signal from pi (pi only knows about the outermost overlay).
    const focused = this.zone === "input";
    const innerWidth = Math.max(2, width - 2); // room for left/right border chars
    const isEmpty = this.input.getValue().length === 0;

    const borderColor = focused ? "accent" : "borderMuted";
    const top = this.theme.fg(borderColor, `\u256d${"\u2500".repeat(width - 2)}\u256e`);
    const bottom = this.theme.fg(borderColor, `\u2570${"\u2500".repeat(width - 2)}\u256f`);
    const sideColor = (s: string) => this.theme.fg(borderColor, s);

    // Always render the Input itself: when focused, its render output
    // includes the CURSOR_MARKER that pi-tui uses to position the hardware
    // cursor. We then optionally overlay placeholder text when the value is
    // empty AND the input is not focused (so we don't clobber the cursor).
    const inputLines = this.input.render(innerWidth);
    const middle = inputLines.map((line) => `${sideColor("\u2502")}${line}${sideColor("\u2502")}`);

    if (isEmpty && !focused) {
      // Replace the (empty) input line with a placeholder hint.
      const placeholder = this.theme.fg("dim", `  ${this.filterPlaceholder}`);
      const padded = padToWidth(placeholder, innerWidth);
      return [top, `${sideColor("\u2502")}${padded}${sideColor("\u2502")}`, bottom];
    }
    return [top, ...middle, bottom];
  }
}

/**
 * Sort items by `id`, case-insensitive, locale-aware.
 *
 * We sort by `id` rather than `label` because labels can include leading
 * status glyphs (e.g. `⏳ angel-content-data`) that vary by item state.
 * Sorting by label would let an icon flip (e.g. ✓ → ⏳ during reconnect)
 * change a row's position in the list, which is jarring. Sorting by id
 * keeps each row in the same place regardless of its display state.
 */
function sortAlpha(items: SettingItem[]): SettingItem[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: "base" }));
}

/**
 * Pad a string to the given visible width with spaces, ignoring ANSI escapes
 * for the width calculation. Cheap approximation: counts only non-escape chars.
 */
function padToWidth(s: string, width: number): string {
  // Strip ANSI for width count (rough — good enough for placeholder padding).
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping requires the literal ESC byte
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
  const pad = Math.max(0, width - visible.length);
  return s + " ".repeat(pad);
}

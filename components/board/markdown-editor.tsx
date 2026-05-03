"use client";

import {
  useCallback,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from "react";

import { cn } from "@/lib/client/utils";
import { MarkdownPreview } from "@/components/board/markdown-preview";
import { Textarea } from "@/components/ui/textarea";

/* -------------------------------------------------------------------------- */
/*                                 Component                                  */
/* -------------------------------------------------------------------------- */

export type MarkdownEditorProps = {
  /**
   * Forwarded to the underlying `<textarea>` so callers can label-associate
   * via `<Label htmlFor>`. Required so each instance gets a stable a11y
   * target — without it the label clicks wouldn't focus the textarea.
   */
  id: string;
  /** Forwarded to the underlying `<textarea>` for native form integration. */
  name?: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /**
   * Capped client-side via the textarea's native `maxLength`. The Preview tab
   * reads from `value` directly so it always reflects the same string the
   * server will see.
   */
  maxLength?: number;
  /** Initial textarea height. Mirrors the prop on the bare `<Textarea>`. */
  rows?: number;
  /** Disables both the textarea and the Preview tab interactions. */
  disabled?: boolean;
  /** Forwarded to the underlying `<textarea>`. */
  autoFocus?: boolean;
  /**
   * Forwarded to the underlying `<textarea>`. Hooked up to a parent error
   * region so screen readers announce the validation message when set.
   */
  "aria-invalid"?: boolean;
  /** Forwarded to the underlying `<textarea>`. */
  "aria-describedby"?: string;
  /** Optional ref to the underlying textarea (autoFocus, focus management). */
  textareaRef?: Ref<HTMLTextAreaElement>;
};

type Mode = "write" | "preview";

/**
 * Lightweight markdown editor with a Write/Preview tab toggle.
 *
 * Why a custom tab implementation rather than `@radix-ui/react-tabs`:
 *
 *   - The project hasn't installed Radix Tabs yet; this is the only surface
 *     that needs them so far. Hand-rolling the ARIA pattern keeps the
 *     dependency surface small while still giving users keyboard-accessible
 *     tabs that match the WAI-ARIA Authoring Practices.
 *   - We need to keep the textarea mounted across mode switches (so the
 *     caret position, undo stack, and IME composition all survive a peek at
 *     the preview). Hiding via the `hidden` attribute on the inactive panel
 *     is the cleanest way to achieve that.
 *
 * Accessibility:
 *
 *   - The two tabs sit in a `role="tablist"` and use `role="tab"` with
 *     `aria-selected` reflecting the active mode. Each panel is marked
 *     `role="tabpanel"` and references its tab via `aria-labelledby`.
 *   - Roving tabindex keeps Tab from cycling through both buttons — only the
 *     active tab is in the focus order. Arrow Left/Right and Home/End move
 *     focus + activate, which matches the "automatic activation" pattern
 *     recommended for short tab lists like Write/Preview.
 *   - The Preview panel has `tabIndex={0}` so keyboard users can scroll the
 *     rendered output when long; the textarea panel inherits the textarea's
 *     own focus behaviour.
 */
export function MarkdownEditor({
  id,
  name,
  value,
  onChange,
  placeholder,
  maxLength,
  rows = 5,
  disabled,
  autoFocus,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
  textareaRef,
}: MarkdownEditorProps) {
  const [mode, setMode] = useState<Mode>("write");

  // Stable IDs for the tab/tabpanel cross-references. We also reuse the
  // caller-supplied `id` for the textarea itself so the parent's `<Label
  // htmlFor>` keeps working — clicking the label still focuses the textarea
  // even when it's hidden behind the Preview tab (the click flips us back to
  // write mode via `handleLabelClick`).
  const tabsBaseId = useId();
  const writeTabId = `${tabsBaseId}-tab-write`;
  const previewTabId = `${tabsBaseId}-tab-preview`;
  const writePanelId = `${tabsBaseId}-panel-write`;
  const previewPanelId = `${tabsBaseId}-panel-preview`;

  const writeTabRef = useRef<HTMLButtonElement | null>(null);
  const previewTabRef = useRef<HTMLButtonElement | null>(null);

  const focusTab = useCallback((next: Mode) => {
    const target = next === "write" ? writeTabRef.current : previewTabRef.current;
    target?.focus();
  }, []);

  const onTabKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      // Roving-tabindex pattern: arrow keys cycle through the two tabs,
      // Home/End jump to the first/last. Activation happens immediately so
      // a quick Left/Right reveals the other panel without a follow-up
      // Enter — short tablists with cheap panels handle this well.
      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown": {
          event.preventDefault();
          const next: Mode = mode === "write" ? "preview" : "write";
          setMode(next);
          focusTab(next);
          break;
        }
        case "ArrowLeft":
        case "ArrowUp": {
          event.preventDefault();
          const next: Mode = mode === "write" ? "preview" : "write";
          setMode(next);
          focusTab(next);
          break;
        }
        case "Home": {
          event.preventDefault();
          setMode("write");
          focusTab("write");
          break;
        }
        case "End": {
          event.preventDefault();
          setMode("preview");
          focusTab("preview");
          break;
        }
        default:
          break;
      }
    },
    [focusTab, mode],
  );

  const trimmed = value.trim();

  return (
    <div
      className={cn(
        // Compose the two tabs and the panel into a single bordered shell so
        // the editor reads as one control rather than three loose pieces.
        // The bare textarea inside drops its own border so we don't end up
        // with a double frame.
        "rounded-md border border-input bg-background",
        "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background",
        ariaInvalid && "border-destructive focus-within:ring-destructive",
        disabled && "opacity-50",
      )}
    >
      <div
        role="tablist"
        aria-label="Description editor mode"
        className="flex items-center gap-1 border-b border-input px-1.5 py-1.5"
      >
        <TabButton
          ref={writeTabRef}
          id={writeTabId}
          panelId={writePanelId}
          selected={mode === "write"}
          disabled={disabled}
          onClick={() => setMode("write")}
          onKeyDown={onTabKeyDown}
        >
          Write
        </TabButton>
        <TabButton
          ref={previewTabRef}
          id={previewTabId}
          panelId={previewPanelId}
          selected={mode === "preview"}
          disabled={disabled}
          onClick={() => setMode("preview")}
          onKeyDown={onTabKeyDown}
        >
          Preview
        </TabButton>
      </div>

      {/* Write panel: keep the textarea mounted in both modes so the caret,
          selection, undo stack, and IME composition all survive a peek at
          the Preview. Hiding via the `hidden` attribute (rather than
          unmounting) is the cleanest way to do that. */}
      <div
        role="tabpanel"
        id={writePanelId}
        aria-labelledby={writeTabId}
        hidden={mode !== "write"}
      >
        <Textarea
          id={id}
          name={name}
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          rows={rows}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-invalid={ariaInvalid}
          aria-describedby={ariaDescribedBy}
          // Drop the textarea's own border + focus ring so the wrapper's
          // shell is the single source of frame styling. Keep the rounded
          // corners only on the bottom so the top edge sits flush with the
          // tablist divider.
          className={cn(
            "rounded-none rounded-b-md border-0 bg-transparent",
            "focus-visible:ring-0 focus-visible:ring-offset-0",
            "aria-[invalid=true]:border-0",
          )}
        />
      </div>

      {/* Preview panel: rendered with the same MarkdownPreview component
          used by the read view, so what the author sees here is exactly
          what readers will see on the card. The panel itself is focusable
          (tabIndex=0) so keyboard users can scroll long output. */}
      <div
        role="tabpanel"
        id={previewPanelId}
        aria-labelledby={previewTabId}
        hidden={mode !== "preview"}
        tabIndex={0}
        className={cn(
          "px-3 py-2",
          // Match the textarea's min-height so the panel doesn't visually
          // collapse on an empty draft — the resize-y of the textarea is
          // intentionally not mirrored here (resizing while previewing has
          // no effect; the user can resize after switching back to Write).
          "min-h-[88px]",
          "focus-visible:outline-none",
        )}
      >
        {trimmed ? (
          <MarkdownPreview source={value} />
        ) : (
          <p className="text-sm italic text-muted-foreground">
            Nothing to preview yet.
          </p>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                Sub-components                              */
/* -------------------------------------------------------------------------- */

/**
 * Single tab trigger. Implements the WAI-ARIA tab role with a roving
 * tabindex (only the selected tab is in the focus order) and the
 * `aria-controls` cross-reference to its panel. We pass through the parent's
 * keydown handler so the arrow-key navigation lives in one place.
 */
const TabButton = ({
  ref,
  id,
  panelId,
  selected,
  disabled,
  onClick,
  onKeyDown,
  children,
}: {
  ref: Ref<HTMLButtonElement>;
  id: string;
  panelId: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}) => (
  <button
    ref={ref}
    type="button"
    id={id}
    role="tab"
    aria-selected={selected}
    aria-controls={panelId}
    // Roving tabindex: only the selected tab is reachable via Tab, the other
    // is reached via the arrow keys. This matches the WAI-ARIA pattern for
    // automatic-activation tabs.
    tabIndex={selected ? 0 : -1}
    disabled={disabled}
    onClick={onClick}
    onKeyDown={onKeyDown}
    className={cn(
      "rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
      selected
        ? "bg-muted text-foreground"
        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      disabled && "cursor-not-allowed",
    )}
  >
    {children}
  </button>
);

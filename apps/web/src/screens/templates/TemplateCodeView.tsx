import { useEffect, useRef, useState } from 'react';
import { toEditorRanges, type AnalysisRange, type EditorRange } from './lint-positions.js';

type Props = {
  value: string;
  ranges: readonly AnalysisRange[];
  disabled?: boolean;
  onChange: (value: string) => void;
  onCaretChange: (offset: number) => void;
};

/**
 * The imperative surface the mounted CodeMirror instance exposes to the React
 * effects below. Everything CodeMirror-typed stays inside the closure that
 * builds it, so this module has no static import of the editor at all — the
 * only way in is the dynamic `import()` in the mount effect, which is what
 * keeps ~1 MB of editor out of the entry bundle.
 */
type EditorHandle = {
  destroy: () => void;
  syncValue: (next: string) => void;
  setLintRanges: (ranges: readonly EditorRange[]) => void;
  setEditable: (editable: boolean) => void;
};

const EDITOR_LABEL = 'Mã HTML của template';

/**
 * The HTML source tab of the template editor.
 *
 * The editor is loaded lazily and is allowed to fail: a template author whose
 * network dropped the editor chunk still gets a plain textarea that edits and
 * saves the same value, because losing a syntax highlighter must never turn
 * the authoring screen into a blank page.
 */
export function TemplateCodeView({ value, ranges, disabled, onChange, onCaretChange }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<EditorHandle | null>(null);
  const [failed, setFailed] = useState(false);

  // The editor mounts once, so its update listener would otherwise close over
  // the first render's props forever. Everything it needs is read through this
  // ref instead, seeded with the first render's values so the async mount below
  // sees real props even if it resolves before any other effect has run.
  const latest = useRef({ value, ranges, disabled, onChange, onCaretChange });
  useEffect(() => {
    latest.current = { value, ranges, disabled, onChange, onCaretChange };
  });

  useEffect(() => {
    let cancelled = false;
    let handle: EditorHandle | null = null;

    const mount = async (): Promise<void> => {
      const [viewModule, htmlModule, stateModule, commandsModule] = await Promise.all([
        import('@codemirror/view'),
        import('@codemirror/lang-html'),
        import('@codemirror/state'),
        import('@codemirror/commands'),
      ]);
      const host = hostRef.current;
      // The component can unmount while the chunk is still in flight. Bail out
      // before touching a ref or calling setState on a dead component.
      if (cancelled || !host) return;

      const { Decoration, EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } = viewModule;
      const { Annotation, Compartment, StateEffect, StateField } = stateModule;

      // Marks transactions this component dispatched itself, so the update
      // listener can tell "the parent handed us new text" from "the user typed".
      const fromParent = Annotation.define<boolean>();
      const setLintRanges = StateEffect.define<readonly EditorRange[]>();
      const editable = new Compartment();

      const lintField = StateField.define({
        create: () => Decoration.none,
        update(decorations, transaction) {
          let next = decorations.map(transaction.changes);
          for (const effect of transaction.effects) {
            if (!effect.is(setLintRanges)) continue;
            next = Decoration.set(
              effect.value.map((range) =>
                Decoration.mark({ class: 'cm-lint-range', attributes: { title: range.key } }).range(range.from, range.to),
              ),
              true,
            );
          }
          return next;
        },
        provide: (field) => EditorView.decorations.from(field),
      });

      const view = new EditorView({
        parent: host,
        doc: latest.current.value,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          drawSelection(),
          commandsModule.history(),
          keymap.of([...commandsModule.defaultKeymap, ...commandsModule.historyKeymap]),
          htmlModule.html(),
          EditorView.lineWrapping,
          // A bare contenteditable has no accessible name; screen readers would
          // announce the editor as an unlabelled edit region without this.
          EditorView.contentAttributes.of({ 'aria-label': EDITOR_LABEL }),
          editable.of(EditorView.editable.of(!latest.current.disabled)),
          lintField,
          EditorView.updateListener.of((update) => {
            const echo = update.transactions.some((transaction) => transaction.annotation(fromParent));
            if (update.docChanged && !echo) latest.current.onChange(update.state.doc.toString());
            if (update.selectionSet) latest.current.onCaretChange(update.state.selection.main.head);
          }),
        ],
      });

      if (cancelled) {
        view.destroy();
        return;
      }

      handle = {
        destroy: () => view.destroy(),
        setEditable: (next) => view.dispatch({ effects: editable.reconfigure(EditorView.editable.of(next)) }),
        setLintRanges: (next) => view.dispatch({ effects: setLintRanges.of(next) }),
        syncValue: (next) => {
          const current = view.state.doc.toString();
          // The loop guard. Dispatching re-enters the update listener, which
          // would report this very string back to the parent, which would hand
          // it straight back as `value`. Comparing first means the second pass
          // finds the documents equal and stops; the `fromParent` annotation
          // above keeps the first pass from even reaching onChange.
          if (current === next) return;
          // Replace only the span that actually differs rather than the whole
          // document. A full replacement maps the caret to the end of the
          // buffer, which is precisely wrong for the variable panel, whose job
          // is to insert at the caret and leave the caret beside the insertion.
          const limit = Math.min(current.length, next.length);
          let prefix = 0;
          while (prefix < limit && current[prefix] === next[prefix]) prefix += 1;
          let suffix = 0;
          while (suffix < limit - prefix && current[current.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix += 1;
          view.dispatch({
            changes: { from: prefix, to: current.length - suffix, insert: next.slice(prefix, next.length - suffix) },
            annotations: fromParent.of(true),
          });
        },
      };
      editorRef.current = handle;
      handle.setLintRanges(toEditorRanges(latest.current.value, latest.current.ranges));
    };

    void mount().catch(() => {
      if (!cancelled) setFailed(true);
    });

    return () => {
      cancelled = true;
      handle?.destroy();
      editorRef.current = null;
    };
  }, []);

  // Outside edits — the variable panel inserting `{{ten_bien}}` at the caret —
  // reach the editor only through here.
  useEffect(() => {
    editorRef.current?.syncValue(value);
  }, [value]);

  useEffect(() => {
    editorRef.current?.setLintRanges(toEditorRanges(value, ranges));
  }, [ranges, value]);

  useEffect(() => {
    editorRef.current?.setEditable(!disabled);
  }, [disabled]);

  if (failed) {
    return (
      <textarea
        className="template-code-fallback"
        value={value}
        rows={18}
        disabled={disabled}
        aria-label={EDITOR_LABEL}
        onChange={(event) => onChange(event.target.value)}
        onSelect={(event) => onCaretChange(event.currentTarget.selectionStart ?? 0)}
      />
    );
  }

  return <div ref={hostRef} className="template-code-view" role="group" aria-label={EDITOR_LABEL} />;
}

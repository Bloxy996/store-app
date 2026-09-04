import { WidgetType } from '@codemirror/view';


// `- [ ]` / `- [x]` task checkboxes render as a real, always-clickable
// checkbox (not just on the cursor's line — Obsidian keeps these live at
// all times), toggling the underlying text directly.
class TaskCheckboxWidget extends WidgetType {
  constructor(checked) {
    super();
    this.checked = checked;
  }
  eq(other) {
    return other.checked === this.checked;
  }
  toDOM(view) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.checked;
    box.className = 'cm-task-checkbox';
    box.setAttribute('data-cm-interactive', 'true');
    box.onmousedown = (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(box);
      view.dispatch({ changes: { from: pos, to: pos + 1, insert: this.checked ? ' ' : 'x' } });
    };
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

export { TaskCheckboxWidget };

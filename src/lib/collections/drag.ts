/**
 * Native HTML5 drag-and-drop (not a custom pointer system — TabCard rows are
 * plain DOM list items, unlike the graph's canvas nodes, which is why
 * GraphCanvas's pointer-based drag doesn't apply here) carrying a single tab
 * id from a TabCard drag source to a CollectionGroup drop target. Centralized
 * so the source and target never disagree on the MIME type string.
 */
export const TAB_DRAG_MIME_TYPE = "application/x-tabdump-tab-id";

export function setDragTabId(dataTransfer: DataTransfer, tabId: string): void {
  dataTransfer.setData(TAB_DRAG_MIME_TYPE, tabId);
  dataTransfer.effectAllowed = "move";
}

export function getDragTabId(dataTransfer: DataTransfer): string | null {
  const id = dataTransfer.getData(TAB_DRAG_MIME_TYPE);
  return id || null;
}

export function hasDragTabId(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(TAB_DRAG_MIME_TYPE);
}

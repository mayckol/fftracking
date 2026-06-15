// Monaco ships no typings for its internal config modules. We only touch the
// global editor-zoom singleton, so declare just what we use.
declare module "monaco-editor/esm/vs/editor/common/config/editorZoom.js" {
  export const EditorZoom: {
    getZoomLevel(): number;
    setZoomLevel(zoomLevel: number): void;
    onDidChangeZoomLevel(listener: (zoomLevel: number) => void): { dispose(): void };
  };
}

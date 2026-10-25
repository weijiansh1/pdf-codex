/// <reference types="vite/client" />

/**
 * Vite inlines the PDF.js worker into the bundle so the MCP UI resource stays a single
 * self-contained HTML file. Inline workers are constructed through a Blob URL.
 */
declare module '*?worker&inline' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}

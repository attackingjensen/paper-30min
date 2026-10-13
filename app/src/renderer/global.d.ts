/// <reference types="vite/client" />
import type { Desktop } from "../shared/contracts";
declare global {
  interface Window {
    desktop: Desktop;
  }
}

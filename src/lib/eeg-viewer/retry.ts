/**
 * The class of the Try again (or Reload page) button in the viewer's failed-open
 * messages (website#416). Three places spell it: the session's own failed-open
 * message, the viewer's "could not load" message, and `eeg-viewer.css`; a test
 * reads the stylesheet, so the selector cannot drift from this name.
 *
 * A module of its own because `viewer-session.ts` loads `viewer.ts` on demand
 * (a failed load is what Reload page is for) and must not import it up front.
 */
export const RETRY_CLASS = "preview__retry";
